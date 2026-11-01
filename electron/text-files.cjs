// Text files on disk for file sheets: encoding and line-ending detection,
// bounded reads of huge files, and atomic writes that keep the original
// encoding (BOM included). Pure Node — no Electron — so it is unit-tested.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { isUtf8: isUtf8Bytes } = require("node:buffer");

/** Files larger than this open read-only, showing only their end. */
const LARGE_FILE_BYTES = 50 * 1024 * 1024;
/** How much of the end of a large file is loaded. */
const TAIL_BYTES = 5 * 1024 * 1024;
/** Bytes compared to tell an append from a rewrite. */
const PROBE_BYTES = 4096;

const BOMS = {
  "UTF-8 BOM": Buffer.from([0xef, 0xbb, 0xbf]),
  "UTF-16 LE": Buffer.from([0xff, 0xfe]),
  "UTF-16 BE": Buffer.from([0xfe, 0xff]),
};
const DECODER_LABEL = {
  "UTF-8": "utf-8",
  "UTF-8 BOM": "utf-8",
  "UTF-16 LE": "utf-16le",
  "UTF-16 BE": "utf-16be",
  "Windows-1252": "windows-1252",
};
const ALIASES = new Map(
  Object.entries({
    "utf-8": "UTF-8",
    utf8: "UTF-8",
    "utf-8-bom": "UTF-8 BOM",
    "utf-8 bom": "UTF-8 BOM",
    "utf8-bom": "UTF-8 BOM",
    utf8bom: "UTF-8 BOM",
    "utf-8-sig": "UTF-8 BOM",
    "utf-16 le": "UTF-16 LE",
    "utf-16le": "UTF-16 LE",
    utf16le: "UTF-16 LE",
    "utf-16": "UTF-16 LE",
    "utf-16 be": "UTF-16 BE",
    "utf-16be": "UTF-16 BE",
    utf16be: "UTF-16 BE",
    "windows-1252": "Windows-1252",
    cp1252: "Windows-1252",
    ansi: "Windows-1252",
  }),
);

/** Canonical encoding label ("UTF-8", "UTF-8 BOM", "UTF-16 LE", "UTF-16 BE", "Windows-1252"). */
function normalizeEncoding(label) {
  if (typeof label !== "string") throw new Error("Unknown encoding.");
  const trimmed = label.trim();
  if (DECODER_LABEL[trimmed]) return trimmed;
  const alias = ALIASES.get(trimmed.toLowerCase());
  if (!alias) throw new Error(`Joty cannot write ${trimmed} files.`);
  return alias;
}

/**
 * The encoding of a file from its first bytes and the bytes to validate as
 * UTF-8. `cut` says the sample stops mid-file, so a character split at its
 * end is not evidence against UTF-8; at the real end of a file it is.
 */
function detectEncoding(head, sample = head, { cut = false } = {}) {
  for (const [label, bom] of Object.entries(BOMS)) {
    if (head.length >= bom.length && head.subarray(0, bom.length).equals(bom)) return label;
  }
  return isUtf8Bytes(cut ? trimPartialUtf8(sample) : sample) ? "UTF-8" : "Windows-1252";
}

/** Drop an incomplete UTF-8 sequence at the end of a sample cut mid-character. */
function trimPartialUtf8(bytes) {
  let end = bytes.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = bytes[end - i];
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (need > i) end -= i;
    break;
  }
  return bytes.subarray(0, end);
}

function bomLength(encoding) {
  return BOMS[encoding]?.length ?? 0;
}

function decode(bytes, encoding) {
  return new TextDecoder(DECODER_LABEL[encoding], { ignoreBOM: true }).decode(bytes);
}

/** NUL bytes outside UTF-16 mean a binary file (images, archives, executables). */
function looksBinary(sample, encoding) {
  if (encoding === "UTF-16 LE" || encoding === "UTF-16 BE") return false;
  return sample.includes(0);
}

/** The predominant line ending; files without one get the platform's. */
function detectEol(text) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  if (crlf === 0 && lf === 0 && cr === 0) return process.platform === "win32" ? "CRLF" : "LF";
  if (crlf >= lf && crlf >= cr) return "CRLF";
  return lf >= cr ? "LF" : "CR";
}

const EOL_TEXT = { LF: "\n", CRLF: "\r\n", CR: "\r" };
const normalizeNewlines = (text) => text.replace(/\r\n?/g, "\n");

function checkEol(eol) {
  if (!Object.hasOwn(EOL_TEXT, eol)) throw new Error("Unknown line ending.");
  return eol;
}

// Windows-1252 has no Node encoder; build the reverse of the WHATWG decoder.
let cp1252Map = null;
function encodeCp1252(text) {
  if (!cp1252Map) {
    cp1252Map = new Map();
    const all = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const chars = new TextDecoder("windows-1252").decode(all);
    for (let i = 0; i < 256; i++) cp1252Map.set(chars[i], i);
  }
  const out = Buffer.alloc(text.length);
  let n = 0;
  for (const ch of text) {
    const b = cp1252Map.get(ch);
    if (b === undefined) {
      throw new Error(
        `This file is Windows-1252 and cannot hold “${ch}”. Write it as UTF-8 instead.`,
      );
    }
    out[n++] = b;
  }
  return out.subarray(0, n);
}

/** Text → bytes in the given encoding (BOM included) and line ending. */
function encodeText(text, encoding, eol) {
  const label = normalizeEncoding(encoding);
  const body = normalizeNewlines(text).replace(/\n/g, EOL_TEXT[checkEol(eol)]);
  let bytes;
  if (label === "Windows-1252") bytes = encodeCp1252(body);
  else if (label === "UTF-16 LE" || label === "UTF-16 BE") {
    bytes = Buffer.from(body, "utf16le");
    if (label === "UTF-16 BE") bytes.swap16();
  } else bytes = Buffer.from(body, "utf8");
  const bom = BOMS[label];
  return bom ? Buffer.concat([bom, bytes]) : bytes;
}

const probeHash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readRange(handle, start, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

/** Where a tail read may start: on a character and, if possible, a line boundary. */
function tailStart(bytes, encoding) {
  let start = 0;
  if (encoding === "UTF-16 LE" || encoding === "UTF-16 BE") {
    // Caller aligned the read to an even offset; skip to after the next newline.
    const nl = encoding === "UTF-16 LE" ? [0x0a, 0x00] : [0x00, 0x0a];
    for (let i = 0; i + 1 < bytes.length && i < 64 * 1024; i += 2) {
      if (bytes[i] === nl[0] && bytes[i + 1] === nl[1]) return i + 2;
    }
    return 0;
  }
  const nl = bytes.indexOf(0x0a);
  if (nl >= 0 && nl < 64 * 1024) return nl + 1;
  // No newline nearby: at least do not start inside a UTF-8 sequence.
  while (start < bytes.length && start < 3 && (bytes[start] & 0xc0) === 0x80) start++;
  return start;
}

/**
 * Read a text file for a file sheet. Files over 50 MB return only their last
 * ~5 MB (truncated, read-only). Text is returned with "\n" line endings; `eol`
 * says what the file uses. `baseline` lets a watcher continue from this read.
 */
async function readTextFile(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("A full file path is required.");
  }
  const canonical = await fsp.realpath(filePath);
  const handle = await fsp.open(canonical, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("That is not a file.");
    const size = stat.size;
    const truncated = size > LARGE_FILE_BYTES;
    const head = await readRange(handle, 0, Math.min(size, 4));
    let bytes;
    let offset;
    if (truncated) {
      offset = size - TAIL_BYTES;
      bytes = await readRange(handle, offset, TAIL_BYTES);
    } else {
      offset = 0;
      bytes = await readRange(handle, 0, size);
    }
    // Validate everything that will be decoded: one stray byte deep in the
    // file still means it is not UTF-8.
    const encoding = detectEncoding(head, bytes);
    if (truncated) {
      if ((encoding === "UTF-16 LE" || encoding === "UTF-16 BE") && offset % 2) {
        bytes = bytes.subarray(1);
        offset++;
      }
      const skip = tailStart(bytes, encoding);
      bytes = bytes.subarray(skip);
      offset += skip;
    } else {
      const bom = bomLength(encoding);
      bytes = bytes.subarray(bom);
      offset = bom;
    }
    if (looksBinary(bytes.subarray(0, 64 * 1024), encoding)) {
      throw new Error("This looks like a binary file. Joty opens text files.");
    }
    const raw = decode(bytes, encoding);
    let readOnly = truncated;
    if (!readOnly) {
      try {
        await fsp.access(canonical, fs.constants.W_OK);
      } catch {
        readOnly = true;
      }
    }
    const end = offset + bytes.length;
    const probeLength = Math.min(PROBE_BYTES, bytes.length);
    return {
      result: {
        path: canonical,
        text: normalizeNewlines(raw),
        encoding,
        eol: detectEol(raw),
        size,
        mtimeMs: stat.mtimeMs,
        truncated,
        readOnly,
      },
      baseline: {
        size: end,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        encoding,
        probeStart: end - probeLength,
        probe: probeHash(bytes.subarray(bytes.length - probeLength)),
        // A trailing CR may be the first half of a CRLF still being written.
        pendingCr: raw.endsWith("\r"),
      },
    };
  } finally {
    await handle.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write a file atomically: same-directory temp file, fsync, rename over the
 * original. Antivirus and indexers briefly lock files on Windows, so the
 * rename is retried; on failure the original is left untouched.
 */
async function writeTextFile(filePath, text, { encoding, eol }) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("A full file path is required.");
  }
  if (typeof text !== "string") throw new Error("Nothing to write.");
  const bytes = encodeText(text, encoding, eol);
  let target = filePath;
  let mode;
  try {
    target = await fsp.realpath(filePath);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error("That is not a file.");
    if (stat.size > LARGE_FILE_BYTES) {
      throw new Error("Joty only loaded the end of this large file, so it will not overwrite it.");
    }
    await fsp.access(target, fs.constants.W_OK).catch(() => {
      throw new Error("This file is read-only.");
    });
    mode = stat.mode;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fsp.open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(temporary, target);
        break;
      } catch (error) {
        const transient = ["EPERM", "EBUSY", "EACCES"].includes(error.code);
        if (!transient || attempt >= 5) throw error;
        await sleep(50 * (attempt + 1));
      }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  const stat = await fsp.stat(target);
  const label = normalizeEncoding(encoding);
  const probeLength = Math.min(PROBE_BYTES, bytes.length - bomLength(label));
  return {
    path: target,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    // What a follower of this file should now treat as already seen.
    baseline: {
      size: bytes.length,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      encoding: label,
      probeStart: bytes.length - probeLength,
      probe: probeHash(bytes.subarray(bytes.length - probeLength)),
      pendingCr: eol === "CR" && normalizeNewlines(text).endsWith("\n"),
    },
  };
}

// Extensions opened as file sheets when dropped onto the window, and the
// ones registered for "Open with". Unknown extensions are sniffed instead.
const TEXT_EXTENSIONS = new Set(
  (
    "txt log md markdown mdx json jsonc json5 ndjson csv tsv xml yml yaml toml ini conf cfg " +
    "config properties env editorconfig gitignore gitattributes ps1 psm1 psd1 sql cs csx " +
    "csproj fsproj vbproj sln props targets ts tsx mts cts js jsx mjs cjs py sh bash zsh bat " +
    "cmd html htm css scss less svg vue go rs java kt c h cpp hpp rb php lua r tex rst " +
    "canvas joty diff patch"
  ).split(" "),
);
const BINARY_EXTENSIONS = new Set(
  (
    "png jpg jpeg gif bmp webp ico tif tiff heic avif pdf zip 7z rar gz tgz bz2 xz exe dll " +
    "msi sys bin iso img dmg mp3 wav flac ogg m4a mp4 mkv mov avi webm docx xlsx pptx doc xls " +
    "ppt odt ods woff woff2 ttf otf eot class jar pyc db sqlite mdb accdb pdb obj lib"
  ).split(" "),
);
const TEXT_NAMES = new Set(["dockerfile", "makefile", "license", "readme", "changelog"]);

function extensionOf(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0) return { base, ext: "" };
  return { base, ext: base.slice(dot + 1) };
}

/** Text-like by name alone: true, false, or null when the content decides. */
function textLikeByName(filePath) {
  const { base, ext } = extensionOf(filePath);
  if (TEXT_EXTENSIONS.has(ext) || (!ext && TEXT_NAMES.has(base))) return true;
  if (BINARY_EXTENSIONS.has(ext)) return false;
  return null;
}

/** Whether a path is a regular text file worth opening as a file sheet. */
async function isTextLikeFile(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    const byName = textLikeByName(filePath);
    if (byName !== null) return byName;
    const handle = await fsp.open(filePath, "r");
    try {
      const sample = await readRange(handle, 0, Math.min(stat.size, 8192));
      return !looksBinary(sample, detectEncoding(sample, sample, { cut: true }));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/** File paths in a command line (first launch or a second instance). */
function fileArguments(argv, workingDirectory, defaultApp = false) {
  return argv
    .slice(1)
    .filter((arg) => arg && !arg.startsWith("-"))
    .slice(defaultApp ? 1 : 0)
    .filter((arg) => !/^[a-z][a-z\d+.-]*:\/\//i.test(arg))
    .map((arg) => path.resolve(workingDirectory, arg));
}

module.exports = {
  LARGE_FILE_BYTES,
  TAIL_BYTES,
  PROBE_BYTES,
  TEXT_EXTENSIONS,
  normalizeEncoding,
  detectEncoding,
  detectEol,
  decode,
  bomLength,
  looksBinary,
  encodeText,
  normalizeNewlines,
  probeHash,
  readRange,
  readTextFile,
  writeTextFile,
  textLikeByName,
  isTextLikeFile,
  fileArguments,
};
