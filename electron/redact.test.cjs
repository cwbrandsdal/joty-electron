const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SECRET,
  MAX_LINE_CHARS,
  composeDiagnostics,
  detectorAvailable,
  redactLogText,
  redactSecrets,
} = require("./redact.cjs");
const log = require("./log.cjs");

// Fixtures are assembled at runtime (as in joty-web's secrets tests) so this
// file holds no token-shaped literal for scanners to flag. None is real.
const MIX = "k9Qz7Lm2Xp4Rt8Vw1Ny6Hb3Jc5Fd0GsTeUaYi";
const join = (...parts) => parts.join("");
const GITHUB = join("ghp", "_", MIX);
const JWT = join("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJvbGEifQ", ".", MIX);
const CONNECTION = "Server=tcp:db.example.test,1433;User Id=app;Password=Tr0ub4dor-n0t-real;";
const PASSWORD = "Tr0ub4dor-n0t-real";

test("the bundled web detector is loaded", () => {
  assert.equal(detectorAvailable(), true, "run npm run build:secrets");
});

test("redactSecrets replaces only the secret values", () => {
  assert.equal(
    redactSecrets(`[sync] failed: ${CONNECTION}`),
    `[sync] failed: Server=tcp:db.example.test,1433;User Id=app;Password=${SECRET};`,
  );
  assert.equal(redactSecrets(`token ${GITHUB} rejected`), `token ${SECRET} rejected`);
  assert.equal(
    redactSecrets(`Authorization: Bearer ${JWT}\nnext line`),
    `Authorization: Bearer ${SECRET}\nnext line`,
  );
  // Two secrets on one line, and JSON-serialized objects.
  assert.equal(
    redactSecrets(JSON.stringify({ password: "Xq7!vLp2#Rk9", api: GITHUB })),
    `{"password":"${SECRET}","api":"${SECRET}"}`,
  );
  assert.equal(redactSecrets("plain line, nothing to hide"), "plain line, nothing to hide");
  assert.equal(redactSecrets(""), "");
  assert.equal(redactSecrets(undefined), "");
});

test("redactSecrets reads private keys across lines", () => {
  const body = Array.from({ length: 3 }, (_, i) => MIX.slice(i) + MIX.slice(0, i)).join("\n");
  const key = join("-----BEGIN ", "PRIVATE KEY-----\n", body, "\n-----END ", "PRIVATE KEY-----");
  const out = redactSecrets(`Error: bad key\n${key}`);
  assert.ok(!out.includes(MIX.slice(3, 20)), out);
  assert.equal(out.split("\n").length, 6);
});

test("long lines are withheld whole; text is cut only after redaction", () => {
  const started = performance.now();
  const long = `${"a".repeat(3000)} ${"b".repeat(2000)}apikey=x`;
  assert.equal(redactSecrets(long), `⟦long line withheld, ${long.length} chars⟧`);
  assert.equal(redactSecrets("x".repeat(MAX_LINE_CHARS)), "x".repeat(MAX_LINE_CHARS));
  assert.ok(performance.now() - started < 1000);
  assert.equal(redactSecrets("short", { max: 10 }), "short");
  // Never inside a marker; at a line end when that keeps at least half.
  assert.equal(
    redactSecrets(`token ${GITHUB} rejected`, { max: 12 }),
    "token … (17 more characters)",
  );
  assert.equal(
    redactSecrets("first line\nsecond line", { max: 15 }),
    "first line… (12 more characters)",
  );
  // Lines that begin past `scan` are dropped unread.
  assert.equal(redactSecrets("one\ntwo\nthree", { scan: 5 }), "one\ntwo… (5 more characters)");
});

test("log lines are written redacted: strings, objects, Errors and the console mirror", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joty-log-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mirrored = [];
  t.mock.method(console, "warn", (line) => mirrored.push(line));
  t.mock.method(console, "error", (line) => mirrored.push(line));
  log.init(dir, { console: true });

  log.warn(`[renderer:main] Uncaught: ${CONNECTION}`);
  log.info("settings", { apiToken: GITHUB, zoom: 1 });
  log.error("[main] uncaught exception", new Error(`could not parse ${JWT}`));
  log.warn(PASSWORD.repeat(2)); // a bare value on its own

  const text = fs.readFileSync(log.file, "utf8");
  for (const value of [PASSWORD, GITHUB, JWT]) assert.ok(!text.includes(value), text);
  assert.match(text, /WARN {2}\[renderer:main\] Uncaught: Server=.*Password=⟦secret⟧;/);
  assert.match(text, /"apiToken":"⟦secret⟧","zoom":1/);
  assert.match(text, /ERROR \[main\] uncaught exception Error: could not parse ⟦secret⟧\n {4}at /);
  assert.match(text, /WARN {2}⟦secret⟧\n/);
  assert.equal(mirrored.length, 3);
  for (const line of mirrored) assert.ok(!line.includes(PASSWORD) && !line.includes(JWT), line);
});

test("tail and Copy diagnostics redact lines an older version wrote raw", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joty-log-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  log.init(dir, { console: false });
  // As 2.0.0 wrote them: no redaction, CRLF from an editor, a stack.
  fs.writeFileSync(
    log.file,
    [
      `2026-10-30T09:00:00.000Z WARN  [sync] paused (1 pending): ${CONNECTION}`,
      `2026-10-30T09:00:01.000Z ERROR ${PASSWORD}x`,
      `2026-10-30T09:00:02.000Z ERROR [main] Error: refused ${GITHUB}`,
      `    at request (C:\\joty\\x.js:1:2) ${JWT}`,
      "2026-10-30T09:00:03.000Z INFO  quitting",
      "",
    ].join("\r\n"),
  );
  log.info("[auth] state → signed-in");

  const tail = log.tail(200);
  for (const value of [PASSWORD, GITHUB, JWT]) assert.ok(!tail.includes(value), tail);
  const lines = tail.split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines[1], `2026-10-30T09:00:01.000Z ERROR ${SECRET}`);
  assert.equal(lines[3], `    at request (C:\\joty\\x.js:1:2) ${SECRET}`);
  assert.equal(lines[4], "2026-10-30T09:00:03.000Z INFO  quitting");
  assert.match(lines[5], /INFO {2}\[auth\] state → signed-in$/);
  assert.equal(log.tail(2).split("\n").length, 2);

  const report = composeDiagnostics({
    header: [
      "Joty 2.0.0 (from source)",
      `Auth: signed-out, last error: invalid_grant for ${JWT}`,
      `Update: error (GET https://u:${PASSWORD}@updates.example.test/latest.yml failed)`,
      `Settings: ${JSON.stringify({ zoomFactor: 1 })}`,
    ],
    logFile: log.file,
    // Even when handed raw text, the tail is redacted again.
    logTail: fs.readFileSync(log.file, "utf8").replace(/\r/g, "").trim(),
  });
  for (const value of [PASSWORD, GITHUB, JWT]) assert.ok(!report.includes(value), report);
  assert.match(report, /^Joty 2\.0\.0 \(from source\)\n/);
  assert.match(report, /last error: invalid_grant for ⟦secret⟧/);
  assert.match(report, /https:\/\/u:⟦secret⟧@updates/);
  assert.match(
    report,
    /--- last log lines \(.*joty-main\.log\) ---\n2026-10-30T09:00:00\.000Z WARN {2}/,
  );
});

// R4/R5 fixtures (synthetic). A password with spaces inside quotes, and a
// value the detector recognizes only when it stands on a line of its own.
const BARE = join("Zq8#vL2!", "mK9$wR4p");
const SPACED = join("Zq8#vL2! ", "ab3$Cd4! ");
const SERVER = "Server=tcp:db.example.test,1433;User Id=app;";
const quoted = (times) => `${SERVER}Password="${SPACED.repeat(times)}";`;
const leaksSpaced = (text) => /Zq8#|vL2!|ab3\$|Cd4!/.test(text);
/** About `chars` characters of harmless lines, each ending in a newline. */
const filler = (chars) =>
  Array.from(
    { length: Math.ceil(chars / 80) },
    (_, i) => `line ${String(i).padStart(5, "0")} ${"x".repeat(68)}\n`,
  ).join("");

test("R4: a quoted password with spaces is detected whole, or its line is withheld whole", () => {
  // Fits the scan limit: detected as one value, closing quote and all.
  assert.equal(redactSecrets(quoted(100)), `${SERVER}Password="${SECRET}";`);
  // Longer than MAX_LINE_CHARS: the whole line is withheld, never a scanned prefix.
  const long = quoted(300);
  assert.ok(long.length > MAX_LINE_CHARS);
  const out = redactSecrets(`before\n${long}\nafter`);
  assert.ok(!leaksSpaced(out), out.slice(0, 400));
  assert.equal(out, `before\n⟦long line withheld, ${long.length} chars⟧\nafter`);
});

test("R4: a log entry is redacted before its 32 KB cut", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joty-log-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  log.init(dir, { console: false });
  // The password line starts just before 32 KB and ends after it.
  const head = filler(32 * 1024 - 400);
  const value = quoted(150);
  assert.ok(head.length < 32 * 1024 && head.length + value.length > 32 * 1024);
  log.warn(`${head}${value}\ntrailing line`);
  log.error("[sync] failed", new Error(`${head}${value}`));
  const text = fs.readFileSync(log.file, "utf8");
  assert.ok(!leaksSpaced(text), text.slice(head.length, head.length + 400));
  assert.ok(text.includes(`${SERVER}Password="${SECRET}";`), "the redacted line is kept");
});

test("R5: a bare secret is redacted through every log entry point", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joty-log-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mirrored = [];
  for (const level of ["log", "warn", "error"]) {
    t.mock.method(console, level, (line) => mirrored.push(line));
  }
  log.init(dir, { console: true });

  log.error("[renderer:main]", BARE);
  log.warn("[renderer:main]", BARE, "(app://joty/assets/index.js)");
  log.info("[auth] refresh failed:", BARE, "retrying in 5s");
  log.error("[main] uncaught exception", new Error(BARE));
  // Learned from the cause's own message, replaced in the outer one.
  log.error(
    "[sync] failed",
    new Error(`could not use ${BARE} for the connection`, { cause: new Error(BARE) }),
  );
  // A value learned from one argument is replaced wherever it appears.
  log.warn(`[sync] retrying with ${BARE} now:`, BARE);

  const text = fs.readFileSync(log.file, "utf8");
  assert.ok(!text.includes(BARE), text);
  for (const line of mirrored) assert.ok(!line.includes(BARE), line);
  assert.equal(mirrored.length, 6);
  assert.match(text, /ERROR \[renderer:main\] ⟦secret⟧\n/);
  assert.match(text, /WARN {2}\[renderer:main\] ⟦secret⟧ \(app:\/\/joty\/assets\/index\.js\)\n/);
  assert.match(text, /INFO {2}\[auth\] refresh failed: ⟦secret⟧ retrying in 5s\n/);
  assert.match(text, /ERROR \[main\] uncaught exception Error: ⟦secret⟧\n {4}at /);
  assert.match(
    text,
    /could not use ⟦secret⟧ for the connection\n {4}at [^]*Caused by: Error: ⟦secret⟧\n/,
  );
  assert.match(text, /WARN {2}\[sync\] retrying with ⟦secret⟧ now: ⟦secret⟧\n/);
});

test("R5: tail and Copy diagnostics see through historical wrappers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joty-log-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  log.init(dir, { console: false });
  const OTHER = join("Wq3%nB7&", "tY5^hJ1x");
  // As 2.0.0 and earlier wrote them, unredacted.
  fs.writeFileSync(
    log.file,
    [
      `2026-10-30T09:00:00.000Z ERROR [renderer:main] ${BARE} (app://joty/assets/index-B1x.js)`,
      `2026-10-30T09:00:01.000Z WARN  [renderer] ${BARE}`,
      `2026-10-30T09:00:02.000Z ERROR [main] uncaught exception Error: ${BARE}`,
      "    at run (app://joty/assets/index-B1x.js:1:2)",
      `2026-10-30T09:00:03.000Z WARN  [updater] error ${BARE}`,
      `2026-10-30T09:00:04.000Z INFO  [sync] retrying with ${BARE} now`,
      `2026-10-30T09:00:05.000Z WARN  [legacy] ${quoted(300)}`,
      "2026-10-30T09:00:06.000Z INFO  quitting",
      "",
    ].join("\n"),
  );

  const tail = log.tail(200);
  assert.ok(!tail.includes(BARE) && !leaksSpaced(tail), tail.slice(0, 2000));
  const lines = tail.split("\n");
  assert.equal(lines.length, 8);
  assert.equal(
    lines[0],
    `2026-10-30T09:00:00.000Z ERROR [renderer:main] ${SECRET} (app://joty/assets/index-B1x.js)`,
  );
  assert.equal(lines[3], "    at run (app://joty/assets/index-B1x.js:1:2)");
  assert.equal(lines[5], `2026-10-30T09:00:04.000Z INFO  [sync] retrying with ${SECRET} now`);
  assert.match(lines[6], /^2026-10-30T09:00:05\.000Z WARN {2}⟦long line withheld, \d+ chars⟧$/);

  const report = composeDiagnostics({
    header: [
      "Joty 2.0.0 (from source)",
      `Auth: signed-out, last error: refresh refused for ${OTHER} today`,
      `Update: error (${BARE})`,
    ],
    // The raw error strings behind the header lines, checked on their own.
    values: [OTHER],
    logFile: log.file,
    logTail: fs.readFileSync(log.file, "utf8"),
  });
  assert.ok(!report.includes(BARE) && !report.includes(OTHER) && !leaksSpaced(report), report);
  assert.match(
    report,
    /last error: refresh refused for ⟦secret⟧ today\nUpdate: error \(⟦secret⟧\)/,
  );
});

test("redactLogText keeps prefixes and line count", () => {
  const text = `2026-11-01T10:00:00.000Z INFO  ${PASSWORD}x\nplain\n\n2026-11-01T10:00:00.000Z WARN  ok`;
  assert.equal(
    redactLogText(text),
    `2026-11-01T10:00:00.000Z INFO  ${SECRET}\nplain\n\n2026-11-01T10:00:00.000Z WARN  ok`,
  );
  assert.equal(redactLogText(""), "");
});

// F3 fixtures (synthetic): a value the detector recognizes only on a line of
// its own, written inside objects, arrays, Maps, Sets and Error properties.
const LOOSE = join("H8#qZ9!p", "N2$rW4ms");
const LOOSE_2 = join("Pm4#tX9!", "kW2$nR7d");

/** A temporary log mirrored to a captured console; `read()` is the log file. */
function capturedLog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joty-log-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mirrored = [];
  for (const level of ["log", "warn", "error"]) {
    t.mock.method(console, level, (line) => mirrored.push(line));
  }
  log.init(dir, { console: true });
  return { mirrored, read: () => fs.readFileSync(log.file, "utf8") };
}

test("F3: a bare value nested in an object is redacted", (t) => {
  const { mirrored, read } = capturedLog(t);
  log.error({ detail: LOOSE });
  log.warn("[sync] failed", { response: { status: 401, body: { reason: LOOSE_2 } } });
  const text = read();
  assert.ok(!text.includes(LOOSE) && !text.includes(LOOSE_2), text);
  for (const line of mirrored) assert.ok(!line.includes(LOOSE) && !line.includes(LOOSE_2), line);
  assert.match(text, /ERROR \{"detail":"⟦secret⟧"\}\n/);
  assert.match(
    text,
    /WARN {2}\[sync\] failed \{"response":\{"status":401,"body":\{"reason":"⟦secret⟧"\}\}\}\n/,
  );
});

test("F3: a bare value in an array is redacted", (t) => {
  const { mirrored, read } = capturedLog(t);
  log.warn("[sync] rejected", [1, [LOOSE], { ids: ["a", LOOSE_2] }]);
  const text = read();
  assert.ok(!text.includes(LOOSE) && !text.includes(LOOSE_2), text);
  for (const line of mirrored) assert.ok(!line.includes(LOOSE), line);
  assert.match(
    text,
    /WARN {2}\[sync\] rejected \[1,\["⟦secret⟧"\],\{"ids":\["a","⟦secret⟧"\]\}\]\n/,
  );
});

test("F3: an Error's extra properties are read on their own", (t) => {
  const { mirrored, read } = capturedLog(t);
  // The extra property is learned, so the copy inside the message goes too.
  const error = Object.assign(new Error(`request failed for ${LOOSE} today`), { detail: LOOSE });
  log.error("[sync] failed", error);
  // An Error inside an object is serialized with its own properties.
  log.error({ error: Object.assign(new Error("refused"), { body: LOOSE_2 }) });
  const text = read();
  assert.ok(!text.includes(LOOSE) && !text.includes(LOOSE_2), text);
  for (const line of mirrored) assert.ok(!line.includes(LOOSE) && !line.includes(LOOSE_2), line);
  assert.match(text, /ERROR \[sync\] failed Error: request failed for ⟦secret⟧ today\n {4}at /);
  assert.match(text, /ERROR \{"error":\{"body":"⟦secret⟧"\}\}\n/);
});

test("F3: Map and Set entries, cycles and depth", (t) => {
  const { read } = capturedLog(t);
  // Not printed (JSON shows a Map as {}), but learned and replaced elsewhere.
  log.warn(`could not use ${LOOSE} here`, new Map([["k", LOOSE]]));
  log.warn(`could not use ${LOOSE_2} here`, new Set([LOOSE_2]));
  const cyclic = { detail: LOOSE };
  cyclic.self = cyclic;
  log.error(cyclic);
  let deep = { detail: LOOSE_2 };
  for (let i = 0; i < 40; i++) deep = { deep };
  log.error(deep);
  const text = read();
  assert.ok(!text.includes(LOOSE) && !text.includes(LOOSE_2), text);
  assert.match(text, /WARN {2}could not use ⟦secret⟧ here \{\}\n/);
  assert.match(text, /ERROR \{"detail":"⟦secret⟧","self":"⟦circular⟧"\}\n/);
  assert.match(text, /"deep":"⟦omitted⟧"/);
});

test("F3: a JSON string value that holds JSON is read too", (t) => {
  const { read } = capturedLog(t);
  log.warn("[sync] response", JSON.stringify({ detail: LOOSE }));
  log.warn("[sync] body", { text: JSON.stringify({ items: [LOOSE_2] }) });
  // Cut-off JSON cannot be read value by value: its line is withheld.
  log.warn("[sync] partial", `{"detail":"${LOOSE}","more":"`);
  const text = read();
  assert.ok(!text.includes(LOOSE) && !text.includes(LOOSE_2), text);
  assert.match(text, /WARN {2}\[sync\] response \{"detail":"⟦secret⟧"\}\n/);
  assert.match(text, /WARN {2}\[sync\] body \{"text":"\{\\"items\\":\[\\"⟦secret⟧\\"\]\}"\}\n/);
  assert.match(text, /WARN {2}\[sync\] partial ⟦structured line withheld⟧\n/);
});

test("F3: tail and Copy diagnostics read historical JSON lines", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joty-log-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  log.init(dir, { console: false });
  const THIRD = join("Rt5&wN8!", "cZ2#pL7k");
  // As earlier versions wrote them: objects JSON-serialized, unredacted.
  fs.writeFileSync(
    log.file,
    [
      `2026-10-30T09:00:00.000Z ERROR {"detail":"${LOOSE}"}`,
      `2026-10-30T09:00:01.000Z WARN  [sync] failed {"status":401,"body":{"items":["${LOOSE_2}"]}} retrying`,
      // Cut off: the payload cannot be parsed, so the line is withheld.
      `2026-10-30T09:00:02.000Z ERROR [sync] {"detail":"${THIRD}","more… (120 more characters)`,
      "2026-10-30T09:00:03.000Z INFO  [net] online, [1,2] {} []",
      "",
    ].join("\n"),
  );
  const tail = log.tail(200);
  for (const value of [LOOSE, LOOSE_2, THIRD]) assert.ok(!tail.includes(value), tail);
  assert.deepEqual(tail.split("\n"), [
    `2026-10-30T09:00:00.000Z ERROR {"detail":"${SECRET}"}`,
    `2026-10-30T09:00:01.000Z WARN  [sync] failed {"status":401,"body":{"items":["${SECRET}"]}} retrying`,
    "2026-10-30T09:00:02.000Z ERROR ⟦structured line withheld⟧",
    "2026-10-30T09:00:03.000Z INFO  [net] online, [1,2] {} []",
  ]);

  const report = composeDiagnostics({
    header: ["Joty 2.0.0 (from source)", `Update: error (could not use ${LOOSE} here)`],
    logFile: log.file,
    logTail: fs.readFileSync(log.file, "utf8"),
  });
  for (const value of [LOOSE, LOOSE_2, THIRD]) assert.ok(!report.includes(value), report);
  assert.match(report, /Update: error \(could not use ⟦secret⟧ here\)/);
  assert.match(report, /ERROR ⟦structured line withheld⟧\n/);
});

test("repeated values: 8+ characters anywhere, shorter ones as whole tokens", () => {
  // Detected short passwords (2 to 7 characters) are replaced in prose too.
  assert.equal(
    redactSecrets("Server=db;Pwd=abc12;\nUse abc12 now."),
    `Server=db;Pwd=${SECRET};\nUse ${SECRET} now.`,
  );
  assert.equal(
    redactSecrets("Server=db;Pwd=ab3;\nUse ab3 now, (ab3), xab3 and ab3_x stay."),
    `Server=db;Pwd=${SECRET};\nUse ${SECRET} now, (${SECRET}), xab3 and ab3_x stay.`,
  );
  assert.equal(
    redactSecrets("Server=db;Password=ab;\nab, cab"),
    `Server=db;Password=${SECRET};\n${SECRET}, cab`,
  );
  // Long values anywhere, even inside a word.
  assert.equal(
    redactSecrets(`${CONNECTION}\nuse x${PASSWORD}y now`),
    `Server=tcp:db.example.test,1433;User Id=app;Password=${SECRET};\nuse x${SECRET}y now`,
  );
  // A learned value never rewrites this module's own markers.
  const long = "a ".repeat(2100);
  assert.equal(
    redactSecrets(`Server=db;Pwd=line;\n${long}\nthe line here`),
    `Server=db;Pwd=${SECRET};\n⟦long line withheld, ${long.length} chars⟧\nthe ${SECRET} here`,
  );
});
