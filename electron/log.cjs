const fs = require("fs");
const path = require("path");
const { VALUE_WITHHELD, createRedactor, isError, redactLogText } = require("./redact.cjs");

// Small rotating file logger for the main process. Diagnostics live in
// <userData>/logs/joty-main.log (rotated at ~1 MB, three generations kept)
// so a misbehaving install can be understood after the fact. Never log
// tokens, note contents, or other secrets through here; as a backstop every
// message (strings, objects, Error stacks) goes through the editor's secret
// detector before it is written or mirrored to the console (redact.cjs);
// so is every string inside an object argument or an Error's properties.
// Pass raw values as their own arguments (`log.warn("[x] failed:", error)`)
// rather than inside a template string: each argument is checked on its own.

const MAX_BYTES = 1024 * 1024;
const GENERATIONS = 3;
/** One entry (a message with its stack) is cut beyond this many characters, after redaction. */
const MAX_ENTRY_CHARS = 32 * 1024;
/** Causes followed from an Error's `cause`. */
const MAX_CAUSES = 5;

let logDir = null;
let logFile = null;
let mirrorToConsole = true;

function init(userDataPath, { console: mirror = true } = {}) {
  logDir = path.join(userDataPath, "logs");
  logFile = path.join(logDir, "joty-main.log");
  mirrorToConsole = mirror;
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    logDir = null;
    logFile = null;
  }
}

function rotateIfNeeded() {
  if (!logFile) return;
  let size = 0;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;
  for (let i = GENERATIONS - 1; i >= 1; i--) {
    const from = `${logFile}.${i}`;
    const to = `${logFile}.${i + 1}`;
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {
      // best effort
    }
  }
  try {
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    // best effort
  }
}

/**
 * An Error's stack followed by its causes' ("Caused by: …"), and the raw
 * messages, which are read on their own: `Error: <value>` hides a value that
 * is recognized only on a line of its own. A cause that is not an Error is
 * written as JSON with its strings redacted.
 */
function describeError(error, redactor) {
  const texts = [];
  const messages = [];
  const seen = new Set();
  for (let e = error; e != null && !seen.has(e) && seen.size <= MAX_CAUSES; e = e.cause) {
    seen.add(e);
    if (!isError(e)) {
      if (typeof e === "string") messages.push(e);
      texts.push(typeof e === "string" ? e : redactor.formatValue(e));
      break;
    }
    const msg = String(e.message ?? "");
    messages.push(msg);
    texts.push(e.stack || msg);
  }
  return { text: texts.join("\nCaused by: "), messages };
}

/**
 * The message part of a log line. First every string inside an object
 * argument is read on its own (keys, array items, Map and Set entries, an
 * Error's message, cause and other properties), so a value recognized only
 * on a line of its own is known before JSON puts it in quotes. Then each
 * argument is formatted (objects as JSON, every string redacted; Errors as
 * their stacks) and redacted on its own, the joined line is redacted, and
 * every value learned on the way is replaced throughout. A line holding JSON
 * that cannot be parsed (a cut-off response body, say) is withheld, as Copy
 * diagnostics would withhold it. Only then is the entry cut to MAX_ENTRY_CHARS.
 */
function message(parts) {
  const redactor = createRedactor();
  const options = { max: MAX_ENTRY_CHARS, strict: true };
  const complete = parts.map((part) =>
    part !== null && typeof part === "object" ? redactor.learnValue(part) : true,
  );
  const pieces = parts.map((part, i) => {
    if (typeof part === "string") return part;
    if (isError(part)) {
      const { text, messages } = describeError(part, redactor);
      for (const msg of messages) redactor.learn(msg, { scan: MAX_ENTRY_CHARS });
      return text;
    }
    // Strings that were not read cannot be written.
    return complete[i] ? redactor.formatValue(part) : VALUE_WITHHELD;
  });
  const redacted = pieces.map((piece) => redactor.redact(piece, options));
  return redactor.redact(redacted.join(" "), options);
}

function write(level, parts) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message(parts)}`;
  if (mirrorToConsole) {
    (level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log)(line);
  }
  if (!logFile) return;
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFile, line + "\n");
  } catch {
    // Logging must never take the app down.
  }
}

const log = {
  init,
  info: (...parts) => write("INFO", parts),
  warn: (...parts) => write("WARN", parts),
  error: (...parts) => write("ERROR", parts),
  /** Compatibility with modules that expect console-like `log`. */
  log: (...parts) => write("INFO", parts),
  get file() {
    return logFile;
  },
  /**
   * Last `lines` lines of the current log file (for diagnostics), redacted
   * again: the file may hold lines an older version wrote unredacted. Pass
   * the diagnostics report's redactor so values learned here are replaced
   * in the rest of the report too.
   */
  tail(lines = 200, redactor) {
    if (!logFile) return "";
    try {
      const text = fs.readFileSync(logFile, "utf8");
      return redactLogText(
        text
          .split("\n")
          .map((line) => line.replace(/\r$/, ""))
          .filter(Boolean)
          .slice(-lines)
          .join("\n"),
        redactor,
      );
    } catch {
      return "";
    }
  },
};

module.exports = log;
