// Follows a text file on disk for a file sheet: appended bytes become
// "append" events, truncation/rotation/rewrites become "replace", deletion
// becomes "removed". fs.watch is only a hint on Windows (it coalesces events
// and loses track of renamed files), so the parent directory is watched and
// a periodic stat reconciles whatever the watcher missed.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  PROBE_BYTES,
  bomLength,
  normalizeNewlines,
  probeHash,
  readRange,
  readTextFile,
} = require("./text-files.cjs");

const DECODER = {
  "UTF-8": "utf-8",
  "UTF-8 BOM": "utf-8",
  "UTF-16 LE": "utf-16le",
  "UTF-16 BE": "utf-16be",
  "Windows-1252": "windows-1252",
};
/** Appends larger than this are sent as a replace (which bounds huge files). */
const MAX_APPEND_BYTES = 8 * 1024 * 1024;

/**
 * What happened between the baseline and a new stat.
 * `tailUnchanged` says whether the bytes the baseline ended with are still there.
 */
function classifyChange(base, stat, tailUnchanged) {
  if (!stat) return "removed";
  if (base.ino && stat.ino && base.ino !== stat.ino) return "replace";
  if (stat.size < base.size) return "replace";
  if (stat.size > base.size) {
    if (!tailUnchanged) return "replace";
    return stat.size - base.size > MAX_APPEND_BYTES ? "replace" : "append";
  }
  if (stat.mtimeMs !== base.mtimeMs) return tailUnchanged ? "touch" : "replace";
  return "none";
}

async function statOrNull(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

async function probeAt(handle, base) {
  if (base.size === 0) return probeHash(Buffer.alloc(0)) === base.probe;
  const bytes = await readRange(handle, base.probeStart, base.size - base.probeStart);
  return probeHash(bytes) === base.probe;
}

/**
 * Start following `filePath`. `baseline` (from readTextFile) is what the
 * renderer already has; without one the current file is taken as the start.
 * Returns { rebase(baseline), close() }.
 */
function createFollower(filePath, { baseline, onEvent, pollMs = 1000, debounceMs = 120 }) {
  let base = baseline ?? null;
  let decoder = null;
  let removed = false;
  let closed = false;
  let generation = 0;
  let running = false;
  let again = false;
  let debounce = null;
  let watcher = null;

  const resetDecoder = () => {
    decoder = base ? new TextDecoder(DECODER[base.encoding] ?? "utf-8", { ignoreBOM: true }) : null;
  };
  resetDecoder();

  function emit(event) {
    if (!closed) onEvent(event);
  }

  async function replace(gen) {
    const { result, baseline: next } = await readTextFile(filePath);
    if (gen !== generation || closed) return;
    base = next;
    resetDecoder();
    emit({ kind: "replace", text: result.text, size: result.size, mtimeMs: result.mtimeMs });
  }

  async function check() {
    const gen = generation;
    if (!base) {
      const { baseline: next } = await readTextFile(filePath);
      if (gen === generation && !closed) {
        base = next;
        resetDecoder();
      }
      return;
    }
    const stat = await statOrNull(filePath);
    if (gen !== generation || closed) return;
    if (!stat) {
      if (!removed) {
        removed = true;
        emit({ kind: "removed" });
      }
      return;
    }
    if (removed) {
      removed = false;
      await replace(gen);
      return;
    }
    if (stat.size === base.size && stat.mtimeMs === base.mtimeMs && stat.ino === base.ino) return;
    const handle = await fsp.open(filePath, "r");
    try {
      const unchanged = stat.size >= base.size && (await probeAt(handle, base));
      const kind = classifyChange(base, stat, unchanged);
      if (gen !== generation || closed) return;
      if (kind === "replace") {
        await replace(gen);
      } else if (kind === "append") {
        const start = Math.max(base.size, bomLength(base.encoding));
        const bytes = await readRange(handle, start, stat.size - start);
        if (gen !== generation || closed) return;
        let raw = decoder.decode(bytes, { stream: true });
        // The previous chunk ended in CR, already sent as a newline: a LF now
        // completes that CRLF rather than starting another line.
        if (base.pendingCr && raw.startsWith("\n")) raw = raw.slice(1);
        const end = start + bytes.length;
        const probeStart = Math.max(0, end - PROBE_BYTES);
        const probeBytes = await readRange(handle, probeStart, end - probeStart);
        base = {
          ...base,
          size: end,
          mtimeMs: stat.mtimeMs,
          ino: stat.ino,
          probeStart,
          probe: probeHash(probeBytes),
          pendingCr: raw.length ? raw.endsWith("\r") : base.pendingCr,
        };
        if (raw)
          emit({
            kind: "append",
            text: normalizeNewlines(raw),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
      } else if (kind === "touch") {
        base = { ...base, mtimeMs: stat.mtimeMs, ino: stat.ino };
      }
    } finally {
      await handle.close();
    }
  }

  async function run() {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await check();
      } while (again && !closed);
    } catch {
      // Locked or briefly unreadable (an editor mid-save): the next poll retries.
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (closed) return;
    clearTimeout(debounce);
    debounce = setTimeout(run, debounceMs);
  }

  const name = path.basename(filePath);
  const same =
    process.platform === "win32"
      ? (a) => a.toLowerCase() === name.toLowerCase()
      : (a) => a === name;
  try {
    watcher = fs.watch(path.dirname(filePath), { persistent: false }, (_event, filename) => {
      if (!filename || same(String(filename))) schedule();
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null; // The poll below still follows the file.
  }
  const poll = setInterval(run, pollMs);
  poll.unref?.();
  if (!base) void run();

  return {
    /** The renderer now has this content (it re-read or wrote the file). */
    rebase(next) {
      generation++;
      base = next;
      removed = false;
      resetDecoder();
    },
    close() {
      closed = true;
      clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
      watcher = null;
    },
  };
}

module.exports = { classifyChange, createFollower, MAX_APPEND_BYTES };
