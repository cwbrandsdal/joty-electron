const fs = require("fs");
const path = require("path");

// Small rotating file logger for the main process. Diagnostics live in
// <userData>/logs/joty-main.log (rotated at ~1 MB, three generations kept)
// so a misbehaving install can be understood after the fact. Never log
// tokens, note contents, or other secrets through here.

const MAX_BYTES = 1024 * 1024;
const GENERATIONS = 3;

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

function format(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level, parts) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${parts.map(format).join(" ")}`;
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
  /** Last `lines` lines of the current log file (for diagnostics). */
  tail(lines = 200) {
    if (!logFile) return "";
    try {
      const text = fs.readFileSync(logFile, "utf8");
      return text.split("\n").filter(Boolean).slice(-lines).join("\n");
    } catch {
      return "";
    }
  },
};

module.exports = log;
