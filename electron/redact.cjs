// Secret redaction for everything the main process writes down: the log file,
// its console mirror and Copy diagnostics. Detection is the web editor's own
// (joty-web/src/joty/engine/secrets.ts, bundled into generated/secrets.cjs by
// scripts/build-secrets.mjs), so a value the editor would mask never reaches
// a log line. Detected values become ⟦secret⟧; the text around them stays.
//
// Three rules keep the detector's view complete:
// - Detection always reads whole lines. A line too long to scan is withheld
//   whole, and text is shortened only after it has been redacted, so a cut
//   can never leave the start of a secret (a quoted password with spaces,
//   say) that the detector no longer recognizes.
// - Each raw piece (a logging argument, a renderer message, an Error message
//   and its causes, a diagnostics field) is read on its own before prefixes
//   such as `[renderer:main]` are added; known wrappers are also stripped
//   from text that already has them. Every value learned that way is then
//   replaced wherever it appears in the final text: a value of 8+ characters
//   anywhere, a shorter one wherever it stands as a whole token (as the web
//   and API redactors do).
// - Structured values are read value by value. Every string in an object,
//   array, Map, Set or Error property (keys too) is read on its own before the
//   object is formatted, and so is every string of a JSON payload found in
//   text (`{"detail":"…"}` in a log line). JSON payloads are rewritten from
//   what was read; under `strict` (every log entry, and log text an older
//   version wrote) a line whose payload cannot be parsed is withheld whole.

const { types } = require("util");

const SECRET = "⟦secret⟧";
const WITHHELD = "⟦withheld: secret detector missing, run npm run build:secrets⟧";
/** In formatted values: deeper than MAX_DEPTH, never read or written. */
const OMITTED = "⟦omitted⟧";
/** In formatted values: an object met again inside itself. */
const CIRCULAR = "⟦circular⟧";
/** A structured value too large to read whole (more than MAX_VALUES parts) or not serializable. */
const VALUE_WITHHELD = "⟦value withheld: too large or unreadable⟧";
/** A log line whose JSON could not be read, under `strict`. */
const STRUCTURED_WITHHELD = "⟦structured line withheld⟧";

let detector = null;
try {
  detector = require("./generated/secrets.cjs");
  if (typeof detector.findSecrets !== "function") detector = null;
} catch {
  detector = null;
}

/** True when the bundled detector loaded (always, in a packaged build). */
const detectorAvailable = () => detector !== null;

/**
 * Longest line handed to the detector. Some of its postprocessing is
 * quadratic in a line's length, and a log line has no business being longer;
 * a longer line is withheld whole (withheldLine), never scanned in part.
 */
const MAX_LINE_CHARS = 4096;
/** A learned value this long is replaced anywhere; a shorter one only as a whole token. */
const ANYWHERE_MIN = 8;
const WORD_CHAR = /[A-Za-z0-9_]/;
/** Nesting read inside structured values (deeper parts are OMITTED). */
const MAX_DEPTH = 16;
/** Parts (strings, keys, objects, …) of structured values one redactor reads, in all. */
const MAX_VALUES = 50_000;
/** A string inside a structured value is read (and written) up to this length. */
const MAX_VALUE_CHARS = 64 * 1024;
/** JSON inside a string inside JSON is read; one level deeper is plain text. */
const MAX_NESTING = 2;
/** `{` / `[` openings tried per line as JSON payloads. */
const MAX_PAYLOADS = 64;

const withheldLine = (chars) => `⟦long line withheld, ${chars} chars⟧`;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** This module's own markers: a learned value is never replaced inside one. */
const OWN_MARKERS = new RegExp(
  `${[SECRET, OMITTED, CIRCULAR, VALUE_WITHHELD, STRUCTURED_WITHHELD].map(escapeRegExp).join("|")}` +
    "|⟦long line withheld, \\d+ chars⟧",
  "g",
);

const isError = (value) => value instanceof Error || types.isNativeError(value);

/**
 * The lines of `text` that begin before `limit`, each whole. A line longer
 * than MAX_LINE_CHARS is given as its length instead of its text. `rest`
 * counts the characters after the last line kept.
 */
function linesOf(text, limit = Infinity) {
  const lines = [];
  let pos = 0;
  for (;;) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl;
    lines.push(end - pos > MAX_LINE_CHARS ? end - pos : text.slice(pos, end));
    if (nl === -1) return { lines, rest: 0 };
    pos = nl + 1;
    if (pos >= limit) return { lines, rest: text.length - pos };
  }
}

/** Leading `[renderer:main] `, `[renderer] `, `[sync] ` tags. */
const TAGS = /^(?:\[[^\]\s]{1,40}\] ?)+/;
/** The ` (source URL)` the console-message wrapper puts after a renderer message. */
const SOURCE = / \([a-z][\w+.-]*:[^\s()]*\)$/i;
const STACK_FRAME = /^\s+at\s/;
const EDGES = /^[([{"'<]+|[)\]}"'>,;:.]+$/g;
const MAX_TOKEN_CHARS = 256;

/**
 * The parts of a line that a wrapper may have hidden from the detector, each
 * to be read as a line of its own: the message inside `[tag] … (source)`, and
 * the last word (`… uncaught exception Error: <value>`, `… error <value>`,
 * `… (<value>)`), since a value recognized only on its own has no spaces.
 */
function unwrapped(line) {
  if (line.length < 8 || STACK_FRAME.test(line)) return [];
  const out = new Set();
  const inner = line.replace(TAGS, "").replace(SOURCE, "");
  if (inner !== line) out.add(inner);
  const trimmed = inner.trimEnd();
  let start = trimmed.length;
  while (start > 0 && trimmed.length - start <= MAX_TOKEN_CHARS && !/\s/.test(trimmed[start - 1]))
    start--;
  if (trimmed.length - start <= MAX_TOKEN_CHARS) {
    const last = trimmed.slice(start);
    out.add(last);
    out.add(last.replace(EDGES, ""));
  }
  out.delete(line);
  return [...out].filter((probe) => probe.length >= 8);
}

/** Replaces merged [start, end) ranges of `line` with ⟦secret⟧. */
function replaceRanges(line, ranges) {
  if (!ranges?.length) return line;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  for (let i = merged.length - 1; i >= 0; i--) {
    const [start, end] = merged[i];
    line = line.slice(0, start) + SECRET + line.slice(end);
  }
  return line;
}

/**
 * Where learned values occur in `text`: [start, end) ranges, a value of
 * ANYWHERE_MIN+ characters anywhere, a shorter one only as a whole token (not
 * next to [A-Za-z0-9_]), never inside one of this module's own markers.
 */
function knownRanges(text, known) {
  const ranges = [];
  for (const value of known) {
    const word = value.length < ANYWHERE_MIN;
    for (let i = text.indexOf(value); i !== -1; i = text.indexOf(value, i + 1)) {
      const end = i + value.length;
      if (word && (WORD_CHAR.test(text[i - 1] ?? "") || WORD_CHAR.test(text[end] ?? ""))) continue;
      ranges.push([i, end]);
    }
  }
  if (!ranges.length) return ranges;
  const markers = [...text.matchAll(OWN_MARKERS)].map((m) => [m.index, m.index + m[0].length]);
  if (!markers.length) return ranges;
  ranges.sort((a, b) => a[0] - b[0]);
  let m = 0;
  return ranges.filter(([start, end]) => {
    while (m < markers.length && markers[m][1] <= start) m++;
    return !(m < markers.length && markers[m][0] <= start && end <= markers[m][1]);
  });
}

/** Where a JSON payload may open: `{"`, `{}`, `["`, `[{`, `[[`, `[]`, `[1`, `[true`… */
const PAYLOAD_OPEN = /\{(?=\s*["}])|\[(?=\s*["{[\]\-\dtfn])/g;

/** The end of the bracketed text opening at `start` (strings skipped), or -1. */
function closingOf(line, start) {
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) if (line[i] === "\\") i++;
      if (i >= line.length) return -1;
    } else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The JSON payloads in a line, parsed: `{ start, end, value }` each.
 * `unreadable` is true when bracketed text that holds a string (a `"`) is
 * not JSON (cut off, say), so its values could not be read one by one.
 */
function payloadsOf(line) {
  const payloads = [];
  let unreadable = false;
  let tries = 0;
  const open = new RegExp(PAYLOAD_OPEN);
  for (let m = open.exec(line); m; m = open.exec(line)) {
    if (++tries > MAX_PAYLOADS) {
      unreadable = true;
      break;
    }
    const start = m.index;
    const end = closingOf(line, start);
    if (end !== -1) {
      try {
        payloads.push({ start, end, value: JSON.parse(line.slice(start, end)) });
        open.lastIndex = end;
        continue;
      } catch {
        // not JSON after all
      }
    }
    if (line.slice(start, end === -1 ? undefined : end).includes('"')) unreadable = true;
  }
  return { payloads, unreadable };
}

/**
 * Shortens text that has already been redacted to at most `max` characters
 * (plus the note), at a line end when that keeps at least half, and never
 * inside a ⟦…⟧ marker. `rest` characters were already left out.
 */
function clipRedacted(text, max, rest = 0) {
  if (text.length <= max && !rest) return text;
  let cut = text.length;
  if (cut > max) {
    cut = max;
    const nl = text.lastIndexOf("\n", cut);
    if (nl >= cut / 2) cut = nl;
    else {
      const open = text.lastIndexOf("⟦", cut - 1);
      if (open !== -1 && text.lastIndexOf("⟧", cut - 1) < open) cut = open;
      const code = text.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
  }
  return `${text.slice(0, cut)}… (${text.length - cut + rest} more characters)`;
}

/**
 * A redaction that remembers what it has seen: `learn` reads text only for
 * its secret values, `learnValue` does the same for every string inside a
 * structured value, `redact` replaces detected ranges and every value learned
 * so far, `formatValue` writes a structured value as JSON with its strings
 * redacted, and `replaceKnown` replaces learned values in finished text. One
 * redactor per log entry or diagnostics report. Fails closed: without the
 * detector, or when it throws, text is withheld.
 */
function createRedactor() {
  const known = new Set();
  let failed = !detector;
  /** Parts of structured values still to be read (MAX_VALUES in all). */
  let budget = MAX_VALUES;
  /** How deep inside structured values (and JSON in their strings) reading is. */
  let nesting = 0;

  const find = (text) => {
    if (failed) return [];
    try {
      return detector.findSecrets(text);
    } catch {
      failed = true;
      return [];
    }
  };
  /** A value, and its JSON-escaped form as it appears inside a JSON string. */
  const remember = (value) => {
    if (!value) return;
    known.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) known.add(escaped);
  };
  const nested = (fn) => {
    nesting++;
    try {
      return fn();
    } finally {
      nesting--;
    }
  };

  /** Detected ranges by line, after learning their values and the unwrapped ones. */
  function scan(lines) {
    const byLine = new Map();
    // Withheld lines are read as empty, which keeps a private key's state.
    const text = lines.map((line) => (typeof line === "string" ? line : "")).join("\n");
    for (const m of find(text)) {
      const value = lines[m.line].slice(m.start, m.end);
      remember(value);
      if (!byLine.has(m.line)) byLine.set(m.line, []);
      byLine.get(m.line).push([m.start, m.end]);
    }
    for (const line of lines) {
      if (typeof line !== "string") continue;
      for (const probe of unwrapped(line)) {
        for (const m of find(probe)) remember(probe.slice(m.start, m.end));
      }
    }
    return byLine;
  }

  /**
   * Learns every string inside `value` on its own: object keys and values,
   * array items, Map keys and values, Set items, an Error's own properties
   * (message, cause, extras; not the stack). Objects already met are skipped;
   * parts deeper than MAX_DEPTH are not read (formatValue omits them too).
   * False when MAX_VALUES ran out, so some strings were not read.
   */
  function learnValue(value) {
    const seen = new Set();
    let complete = true;
    const visit = (v, depth) => {
      if (!complete) return;
      if (typeof v === "string") {
        if (!v) return;
        if (--budget < 0) complete = false;
        else learnText(v, MAX_VALUE_CHARS);
        return;
      }
      if (v === null || typeof v !== "object" || seen.has(v) || depth >= MAX_DEPTH) return;
      if (--budget < 0) {
        complete = false;
        return;
      }
      seen.add(v);
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return;
      try {
        if (v instanceof Map) {
          for (const [key, item] of v) {
            visit(key, depth + 1);
            visit(item, depth + 1);
            if (!complete) return;
          }
        } else if (v instanceof Set) {
          for (const item of v) {
            visit(item, depth + 1);
            if (!complete) return;
          }
        } else if (Array.isArray(v)) {
          for (let i = 0; i < v.length && complete; i++) visit(v[i], depth + 1);
        } else {
          const keys = isError(v) ? Object.getOwnPropertyNames(v) : Object.keys(v);
          for (const key of keys) {
            if (key === "stack" && isError(v)) continue;
            visit(key, depth + 1);
            visit(v[key], depth + 1);
            if (!complete) return;
          }
        }
      } catch {
        // A throwing getter or proxy: what it hides is not written either.
      }
    };
    nested(() => visit(value, 0));
    return complete;
  }

  /**
   * Learns `lines` (detected values, unwrapped parts) and the values of their
   * JSON payloads. `payloads` has, per line with any, `{ payloads, readable }`:
   * `readable` is false when a payload could not be parsed or read whole.
   */
  function learnLines(lines) {
    const byLine = scan(lines);
    if (nesting >= MAX_NESTING) return { byLine, payloads: null };
    let any = false;
    const payloads = lines.map((line) => {
      if (typeof line !== "string" || (!line.includes("{") && !line.includes("["))) return null;
      const found = payloadsOf(line);
      if (!found.payloads.length && !found.unreadable) return null;
      any = true;
      let readable = !found.unreadable;
      for (const p of found.payloads) if (!learnValue(p.value)) readable = false;
      return { payloads: found.payloads, readable };
    });
    return { byLine, payloads: any ? payloads : null };
  }

  function learnText(text, limit = Infinity) {
    if (typeof text !== "string" || !text) return;
    learnLines(linesOf(text, limit).lines);
  }

  function replaceKnown(text) {
    if (failed) return WITHHELD;
    if (typeof text !== "string" || !text || !known.size) return text ?? "";
    return replaceRanges(text, knownRanges(text, known));
  }

  /**
   * Redacts `text`: whole lines beginning before `scan` (default `max`)
   * are read, longer-than-scannable lines are withheld, later lines are
   * dropped, and only then is the result cut to `max`. JSON payloads are
   * rewritten by formatValue; with `strict`, a line holding a payload that
   * could not be read whole is withheld instead.
   */
  function redact(text, { max = Infinity, scan: limit = max, strict = false } = {}) {
    if (typeof text !== "string") text = String(text ?? "");
    if (!text) return text;
    if (failed) return WITHHELD;
    const { lines, rest } = linesOf(text, limit);
    let { byLine, payloads } = learnLines(lines);
    let read = lines;
    if (payloads) {
      // Every value of the text is known by now, so each payload is written
      // knowing them all; then the rewritten lines are read for ranges.
      read = lines.map((line, i) => {
        const found = payloads[i];
        if (!found) return line;
        if (strict && !found.readable) return STRUCTURED_WITHHELD;
        let out = "";
        let at = 0;
        for (const p of found.payloads) {
          out += line.slice(at, p.start) + formatValue(p.value);
          at = p.end;
        }
        return out + line.slice(at);
      });
      byLine = scan(read);
    }
    if (failed) return WITHHELD;
    const out = read
      .map((line, i) =>
        typeof line === "string" ? replaceRanges(line, byLine.get(i)) : withheldLine(line),
      )
      .join("\n");
    return clipRedacted(replaceKnown(out), max, rest);
  }

  /**
   * `value` as JSON (JSON.stringify's rules: toJSON, own enumerable keys), every
   * string redacted on its own. A cycle is written ⟦circular⟧, parts deeper
   * than MAX_DEPTH ⟦omitted⟧; a value with more than MAX_VALUES parts, or one
   * that cannot be serialized, is withheld whole. Non-objects as JSON writes
   * them (`undefined` and functions as ""; a BigInt as its digits).
   */
  function formatValue(value) {
    if (typeof value === "bigint") return String(value);
    const open = []; // the objects being written, outermost first
    let parts = 0;
    function replacer(key, v) {
      // `this` holds `v`; the objects opened after it are finished.
      open.length = open.lastIndexOf(this) + 1;
      if (++parts > MAX_VALUES) throw new RangeError("too many parts");
      if (typeof v === "string") return v && redact(v, { max: MAX_VALUE_CHARS });
      if (typeof v === "bigint") return String(v);
      if (v === null || typeof v !== "object") return v;
      if (open.includes(v)) return CIRCULAR;
      if (open.length >= MAX_DEPTH) return OMITTED;
      open.push(v);
      return v;
    }
    return nested(() => {
      try {
        return JSON.stringify(value, replacer) ?? "";
      } catch {
        return VALUE_WITHHELD;
      }
    });
  }

  return {
    /** Learns the secret values in `text` (whole lines beginning before `scan`). */
    learn(text, { scan: limit = Infinity } = {}) {
      learnText(text, limit);
    },
    learnValue,
    redact,
    formatValue,
    replaceKnown,
  };
}

/**
 * Replaces every secret the editor's detector finds with ⟦secret⟧, and every
 * other occurrence of a detected value. Options as for createRedactor's
 * `redact` ({ max, scan }). Fails closed: without the detector (a source
 * checkout that skipped the build step) the whole text is withheld rather
 * than written unchecked.
 */
function redactSecrets(text, options) {
  return createRedactor().redact(text, options);
}

/** `2026-11-01T10:00:00.000Z INFO  ` — the prefix log.cjs puts on each entry. */
const LOG_PREFIX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z (?:INFO |WARN |ERROR) /;

/**
 * Redacts log file text line by line. The timestamp and level are set aside,
 * and the tags and source an entry was wrapped in are seen through, so each
 * message is read as written (a bare value on its own still counts as a
 * value on its own line); continuation lines (stacks) are read whole. The
 * JSON an entry holds (objects an older version serialized unredacted) is
 * parsed and its strings read one by one; a line whose JSON cannot be parsed
 * (cut off, say) is withheld as ⟦structured line withheld⟧. Values learned
 * anywhere are replaced everywhere.
 */
function redactLogText(text, redactor = createRedactor()) {
  if (typeof text !== "string" || !text) return text ?? "";
  if (!detector) return WITHHELD;
  const lines = text.split("\n");
  const prefixes = lines.map((line) => LOG_PREFIX.exec(line)?.[0] ?? "");
  const body = lines.map((line, i) => line.slice(prefixes[i].length)).join("\n");
  const bodies = redactor.redact(body, { strict: true });
  if (bodies === WITHHELD) return WITHHELD;
  return bodies
    .split("\n")
    .map((body, i) => (prefixes[i] ?? "") + body)
    .join("\n");
}

/**
 * The Copy diagnostics report: the header lines, then the log tail, both
 * redacted. `values` are the raw strings the header lines embed (auth,
 * update and hotkey errors), read on their own first. A value learned in
 * any part is replaced in all of them.
 */
function composeDiagnostics({
  header,
  values = [],
  logFile,
  logTail,
  redactor = createRedactor(),
}) {
  for (const value of values) if (value) redactor.learn(String(value));
  for (const line of header) redactor.learn(line);
  const tail = redactLogText(logTail ?? "", redactor);
  const head = redactor.redact(header.join("\n"));
  return redactor.replaceKnown(
    [head, "", `--- last log lines (${logFile ?? "no log file"}) ---`, tail].join("\n"),
  );
}

module.exports = {
  SECRET,
  WITHHELD,
  OMITTED,
  CIRCULAR,
  VALUE_WITHHELD,
  STRUCTURED_WITHHELD,
  MAX_LINE_CHARS,
  isError,
  createRedactor,
  detectorAvailable,
  redactSecrets,
  redactLogText,
  composeDiagnostics,
};
