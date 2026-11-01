const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const log = require("./log.cjs");
const { SECRET } = require("./redact.cjs");
const { attachRendererLogging, logRendererMessage } = require("./renderer-log.cjs");

// Synthetic values, assembled at runtime: a value recognized only on a line
// of its own, and a quoted connection-string password containing spaces.
const join = (...parts) => parts.join("");
const BARE = join("Zq8#vL2!", "mK9$wR4p");
const SPACED = join("Zq8#vL2! ", "ab3$Cd4! ");
const SERVER = "Server=tcp:db.example.test,1433;User Id=app;";
const quoted = (times) => `${SERVER}Password="${SPACED.repeat(times)}";`;
const leaks = (text) => text.includes(BARE) || /Zq8#|vL2!|ab3\$|Cd4!/.test(text);
const filler = (chars) =>
  Array.from(
    { length: Math.ceil(chars / 80) },
    (_, i) => `line ${String(i).padStart(5, "0")} ${"x".repeat(68)}\n`,
  ).join("");
const SOURCE = "app://joty/assets/index-B1x.js";

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joty-renderer-log-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  log.init(dir, { console: false });
  return () => fs.readFileSync(log.file, "utf8");
}

test("console messages: the raw message is redacted before the [renderer:name] wrapper", (t) => {
  const read = setup(t);
  const webContents = new EventEmitter();
  attachRendererLogging(webContents, "main", log);

  webContents.emit("console-message", { level: "error", message: BARE, sourceId: SOURCE });
  webContents.emit("console-message", { level: "warning", message: BARE, sourceId: "" });
  // Electron < 35: (event, level, message, line, sourceId).
  webContents.emit("console-message", {}, 3, `Uncaught Error: ${BARE}`, 12, SOURCE);
  webContents.emit("console-message", { level: "info", message: "not logged" });
  // A quoted password with spaces crossing the 32 KB entry cut.
  webContents.emit("console-message", {
    level: "error",
    message: `${filler(32 * 1024 - 400)}${quoted(150)}`,
    sourceId: SOURCE,
  });

  const text = read();
  assert.ok(!leaks(text), text.slice(0, 600));
  assert.ok(!text.includes("not logged"));
  const lines = text.split("\n").filter((line) => /^\d{4}-/.test(line));
  assert.equal(lines.length, 4);
  assert.match(lines[0], new RegExp(`ERROR \\[renderer:main\\] ${SECRET} \\(app://joty/`));
  assert.match(lines[1], new RegExp(`WARN {2}\\[renderer:main\\] ${SECRET}$`));
  assert.match(lines[2], new RegExp(`ERROR \\[renderer:main\\] Uncaught Error: ${SECRET} \\(app:`));
  assert.ok(text.includes(`${SERVER}Password="${SECRET}"; (${SOURCE})`), "redacted, not cut");
});

test("joty:log calls: redacted whole before the 16 KB scan bound and the 2,000-character cut", (t) => {
  const read = setup(t);
  logRendererMessage(log, "error", BARE);
  // One line crossing 2,000, 4,096 and 16 KB: withheld whole, never a prefix.
  const long = quoted(1000);
  assert.ok(long.length > 16 * 1024);
  logRendererMessage(log, "warn", long);
  // A password line crossing the 2,000-character cut is redacted, then cut.
  logRendererMessage(log, "info", `${"y".repeat(1990)} ${quoted(20)}`);
  // A value learned from a later line (within the scan bound) is replaced in
  // the first, which is all the 2,000-character cut keeps.
  logRendererMessage(
    log,
    "info",
    `uses ${BARE} for the sync\n${filler(15 * 1024)}${SERVER}Password=${BARE};`,
  );

  const text = read();
  assert.ok(!leaks(text), text.slice(0, 600));
  const lines = text.split("\n");
  assert.match(lines[0], new RegExp(`ERROR \\[renderer\\] ${SECRET}$`));
  assert.match(
    lines[1],
    new RegExp(`WARN {2}\\[renderer\\] ⟦long line withheld, ${long.length} chars⟧$`),
  );
  assert.match(lines[2], /INFO {2}\[renderer\] y{1990} Server=.*… \(\d+ more characters\)$/);
  assert.ok(lines[2].length < 2100, String(lines[2].length));
  assert.match(lines[3], new RegExp(`INFO {2}\\[renderer\\] uses ${SECRET} for the sync$`));
});
