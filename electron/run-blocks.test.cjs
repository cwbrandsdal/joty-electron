const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SQL_SEPARATOR,
  STALE_TEMP_MS,
  createSqlcmdParser,
  findPowerShell,
  parseConnectionString,
  powershellBootstrap,
  shutdown,
  sqlcmdLaunch,
  startRun,
  sweepTempFiles,
  tokenizeConnectionString,
} = require("./run-blocks.cjs");

// Connection strings here are synthetic test data, not real credentials.
test("connection strings: aliases, quoting and braces", () => {
  assert.deepEqual(tokenizeConnectionString(`Server=a;Password="x;""y""";Pwd={p;q}}r};A==B=c; ;`), [
    ["server", "a"],
    ["password", 'x;"y"'],
    ["pwd", "p;q}r"],
    ["a=b", "c"],
  ]);
  assert.deepEqual(
    parseConnectionString(
      "Data Source=tcp:db.example.test,1433;Initial Catalog=Notes;User ID=reader;Password='s3;cret';Encrypt=True;TrustServerCertificate=yes;Connect Timeout=5",
    ),
    {
      server: "tcp:db.example.test,1433",
      database: "Notes",
      integrated: false,
      user: "reader",
      password: "s3;cret",
      encrypt: "mandatory",
      trustServerCertificate: true,
      timeout: 5,
    },
  );
  assert.deepEqual(parseConnectionString("Server=(localdb)\\MSSQLLocalDB;Trusted_Connection=Yes"), {
    server: "(localdb)\\MSSQLLocalDB",
    database: null,
    integrated: true,
  });
  // Integrated security wins over a stray user, as in SqlClient.
  const both = parseConnectionString("Server=x;Integrated Security=SSPI;UID=u;PWD=p");
  assert.equal(both.integrated, true);
  assert.equal(both.password, undefined);
  assert.equal(parseConnectionString("Address=x;Encrypt=Optional").encrypt, "optional");
  assert.throws(() => parseConnectionString("Database=x"), /no Server/);
  assert.throws(() => parseConnectionString("Server=x;Integrated Security=false"), /no User Id/);
  assert.throws(() => parseConnectionString("Server=x;Password='open"), /unclosed quote/);
  assert.throws(() => parseConnectionString("Server=x;Encrypt=maybe"), /Encrypt/);
});

const EXE =
  "C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE";
const INPUT = "C:\\Temp\\joty-run-1.sql";
const launch = (connection, variant) =>
  sqlcmdLaunch(parseConnectionString(connection), { exe: EXE, inputFile: INPUT, variant, env: {} });

test("ODBC sqlcmd: connection values travel in the environment, never on the command line", () => {
  const run = launch(
    'Server=db&calc;Database=No%tes;User Id=reader"x;Password=hunter2;Encrypt=true;TrustServerCertificate=true;Connect Timeout=7',
    { kind: "odbc", major: 16 },
  );
  const commandLine = [run.file, ...run.args].join(" ");
  for (const value of ["hunter2", "db&calc", "No%tes", "reader", "-P", "-U", "-S"]) {
    assert.ok(!commandLine.includes(value), `${value} is not on the command line`);
  }
  assert.deepEqual(
    {
      server: run.env.SQLCMDSERVER,
      db: run.env.SQLCMDDBNAME,
      user: run.env.SQLCMDUSER,
      password: run.env.SQLCMDPASSWORD,
      timeout: run.env.SQLCMDLOGINTIMEOUT,
      separator: run.env.SQLCMDCOLSEP,
    },
    {
      server: "db&calc",
      db: "No%tes",
      user: 'reader"x',
      password: "hunter2",
      timeout: "7",
      separator: SQL_SEPARATOR,
    },
  );
  if (process.platform === "win32") {
    assert.match(run.file, /cmd\.exe$/i);
    assert.equal(run.verbatim, true);
    assert.deepEqual(run.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(
      run.args[3],
      `"chcp 65001>nul && "${EXE}" -N -C -W -r 0 -b -f 65001 -i "${INPUT}""`,
    );
  }
  const integrated = launch("Server=db;Trusted_Connection=true", { kind: "odbc", major: 16 });
  assert.ok(integrated.args.join(" ").includes("-E"));
  assert.equal(integrated.env.SQLCMDUSER, undefined);
  assert.equal(integrated.env.SQLCMDPASSWORD, undefined);
  const v18 = launch("Server=db;Integrated Security=true;Encrypt=false", {
    kind: "odbc",
    major: 18,
  });
  assert.ok(v18.args.join(" ").includes("-No"));
  assert.throws(() => launch("Server=db;Integrated Security=true;Encrypt=strict"), /sqlcmd 18/);
});

test("Go sqlcmd is started directly with arguments, password still in the environment", () => {
  const run = launch("Server=db;Database=Notes;UID=u;PWD=p;Encrypt=strict", {
    kind: "go",
    major: 0,
  });
  assert.equal(run.file, EXE);
  assert.equal(run.verbatim, false);
  assert.deepEqual(run.args.slice(0, 6), ["-S", "db", "-d", "Notes", "-U", "u"]);
  assert.deepEqual(run.args.slice(run.args.indexOf("-N"), run.args.indexOf("-N") + 2), [
    "-N",
    "strict",
  ]);
  assert.ok(!run.args.includes("p") && !run.args.includes("-f"));
  assert.equal(run.env.SQLCMDPASSWORD, "p");
});

/** Feed text the way lineSplitter does: a final newline ends the last line. */
function parse(text, options) {
  const events = [];
  const parser = createSqlcmdParser((e) => events.push(e), { separator: "|", ...options });
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) parser.line(line);
  parser.end();
  return events;
}

test("sqlcmd output: several result sets, messages and row counts", () => {
  const out = [
    "Changed database context to 'Notes'.",
    "Id|Title|Note",
    "--|-----|----",
    "1|Hei|NULL",
    "2|Blåbær|x",
    "",
    "(2 rows affected)",
    "hello from PRINT",
    "Total",
    "-----",
    "42",
    "",
    "(1 row affected)",
    "A|A",
    "-|-",
    "",
    "(0 rows affected)",
    "",
  ].join("\r\n");
  assert.deepEqual(parse(out), [
    { type: "stdout", text: "Changed database context to 'Notes'." },
    {
      type: "table",
      columns: ["Id", "Title", "Note"],
      rows: [
        ["1", "Hei", "NULL"],
        ["2", "Blåbær", "x"],
      ],
    },
    { type: "stdout", text: "(2 rows affected)" },
    { type: "stdout", text: "hello from PRINT" },
    { type: "table", columns: ["Total"], rows: [["42"]] },
    { type: "stdout", text: "(1 row affected)" },
    { type: "table", columns: ["A", "A"], rows: [] },
    { type: "stdout", text: "(0 rows affected)" },
  ]);
});

test("sqlcmd output: unnamed columns, dashed data and row limits", () => {
  assert.deepEqual(parse("|x\n-|-\n|1\n--|2\n"), [
    {
      type: "table",
      columns: ["", "x"],
      rows: [
        ["", "1"],
        ["--", "2"],
      ],
    },
  ]);
  const many = ["N", "-", ...Array.from({ length: 5 }, (_, i) => String(i)), ""].join("\n");
  assert.deepEqual(parse(many, { maxRows: 3 }).slice(0, 2), [
    { type: "table", columns: ["N"], rows: [["0"], ["1"], ["2"]] },
    { type: "stdout", text: "(2 more rows not shown)" },
  ]);
  // A row with the wrong shape ends the table and is shown as text.
  assert.deepEqual(parse("A|B\n-|-\n1|2\nstray\n").slice(0, 2), [
    { type: "table", columns: ["A", "B"], rows: [["1", "2"]] },
    { type: "stdout", text: "stray" },
  ]);
});

test("the PowerShell bootstrap is one line with the code in base64", () => {
  const line = powershellBootstrap("Write-Output 'æ'\nexit 3");
  assert.equal(line.split("\n").length, 2);
  assert.ok(line.endsWith("\n"));
  assert.ok(!line.includes("Write-Output"));
  assert.ok(line.includes(Buffer.from("Write-Output 'æ'\nexit 3").toString("base64")));
});

function collect(req, exes) {
  return new Promise((resolve) => {
    const events = [];
    startRun(
      req,
      (e) => {
        events.push(e);
        if (e.type === "exit") resolve(events);
      },
      { exes },
    );
  });
}

const powershell = process.platform === "win32" ? findPowerShell() : null;

test("PowerShell runs stream output and report the exit code", { skip: !powershell }, async () => {
  const events = await collect(
    {
      language: "powershell",
      code: "Write-Output 'Blåbær 👋'\nif ($true) {\n  Write-Output 'multi'\n}\n[Console]::Error.WriteLine('oops')\nexit 3",
    },
    { powershell, sqlcmd: null },
  );
  const out = events.filter((e) => e.type === "stdout").map((e) => e.text);
  assert.deepEqual(out, ["Blåbær 👋", "multi"]);
  assert.deepEqual(
    events.filter((e) => e.type === "stderr").map((e) => e.text),
    ["oops"],
  );
  const exit = events.at(-1);
  assert.equal(exit.type, "exit");
  assert.equal(exit.code, 3);
  assert.ok(exit.ms >= 0);
});

test("PowerShell parse errors fail the run", { skip: !powershell }, async () => {
  const events = await collect(
    { language: "powershell", code: "if (" },
    { powershell, sqlcmd: null },
  );
  assert.ok(events.some((e) => e.type === "stderr"));
  assert.equal(events.at(-1).code, 1);
});

test("cancel stops a long PowerShell run", { skip: !powershell }, async () => {
  const events = [];
  const done = new Promise((resolve) => {
    const cancel = startRun(
      { language: "powershell", code: "Write-Output 'started'; Start-Sleep -Seconds 60" },
      (e) => {
        events.push(e);
        if (e.type === "stdout") cancel();
        if (e.type === "exit") resolve();
      },
      { exes: { powershell, sqlcmd: null } },
    );
  });
  const started = Date.now();
  await done;
  assert.ok(Date.now() - started < 20000);
  assert.ok(events.some((e) => e.type === "stderr" && e.text === "Stopped."));
});

test("missing interpreters and bad requests become error events", async () => {
  let events = await collect(
    { language: "sql", code: "select 1", connectionString: "Server=x" },
    {
      powershell: null,
      sqlcmd: null,
    },
  );
  assert.equal(events[0].type, "error");
  assert.match(events[0].message, /sqlcmd was not found/);
  assert.equal(events[1].type, "exit");
  events = await collect({ language: "python", code: "1" }, { powershell: null, sqlcmd: null });
  assert.match(events[0].message, /PowerShell and SQL/);
});

// ---------- temp .sql files ----------

const sqlFiles = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith(".sql"));
const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joty-run-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function until(fn, what, timeout = 5000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function runCollect(req, exes, tmpDir) {
  const events = [];
  let cancel;
  const done = new Promise((resolve) => {
    cancel = startRun(
      req,
      (e) => {
        events.push(e);
        if (e.type === "exit") resolve(events);
      },
      { exes, tmpDir },
    );
  });
  return { events, done, cancel };
}

/**
 * A stand-in sqlcmd: prints the -i file (proof it existed), then optionally
 * waits. The blank line releases the line the output parser holds back as a
 * possible table header.
 */
function fakeSqlcmd(dir, { wait = false } = {}) {
  const file = path.join(dir, "fake-sqlcmd.cmd");
  fs.writeFileSync(
    file,
    [
      "@echo off",
      ":loop",
      'if "%~1"=="" goto end',
      'if "%~1"=="-i" (type "%~2" & echo. & goto end)',
      "shift",
      "goto loop",
      ":end",
      wait ? "ping -n 30 127.0.0.1 >nul" : "exit /b 0",
      "",
    ].join("\r\n"),
  );
  return file;
}

const windows = process.platform === "win32";
const SQL_REQ = {
  language: "sql",
  code: "select 1 as one",
  connectionString: "Server=x;Integrated Security=true",
};

test("a SQL run deletes its temp query file when it ends", { skip: !windows }, async (t) => {
  const dir = tempDir(t);
  const { events, done } = runCollect(SQL_REQ, { sqlcmd: fakeSqlcmd(dir) }, dir);
  await done;
  // The fake read the file, so it existed with the query in it.
  assert.ok(
    events.some((e) => e.type === "stdout" && e.text.includes("select 1 as one")),
    JSON.stringify(events),
  );
  assert.equal(events.at(-1).code, 0);
  await until(() => sqlFiles(dir).length === 0, "the temp file to go");
});

test("a SQL run that cannot start deletes its temp query file", async (t) => {
  const dir = tempDir(t);
  // `%` keeps cmd.exe out of it, so spawn itself fails (ENOENT).
  const missing = path.join(dir, "no%such", "sqlcmd.exe");
  const { events, done } = runCollect(SQL_REQ, { sqlcmd: missing }, dir);
  await done;
  assert.equal(events[0].type, "error");
  assert.match(events[0].message, /Could not start/);
  await until(() => sqlFiles(dir).length === 0, "the temp file to go");
});

test("cancelling right away leaves no temp query file", { skip: !windows }, async (t) => {
  const dir = tempDir(t);
  const exe = fakeSqlcmd(dir, { wait: true });
  for (let i = 0; i < 5; i++) {
    const { done, cancel } = runCollect(SQL_REQ, { sqlcmd: exe }, dir);
    setTimeout(cancel, i * 3);
    await done;
  }
  await until(() => sqlFiles(dir).length === 0, "the temp files to go");
});

test(
  "quitting kills a running SQL run and deletes its file at once",
  { skip: !windows },
  async (t) => {
    const dir = tempDir(t);
    const { events, done } = runCollect(SQL_REQ, { sqlcmd: fakeSqlcmd(dir, { wait: true }) }, dir);
    await until(() => events.some((e) => e.type === "stdout"), "the run to start", 10000);
    const [file] = sqlFiles(dir);
    assert.match(file, new RegExp(String.raw`^joty-run-${process.pid}-[0-9a-f-]{36}\.sql$`));
    const started = Date.now();
    shutdown();
    assert.deepEqual(sqlFiles(dir), [], "deleted before shutdown() returns");
    await done;
    assert.ok(Date.now() - started < 10000, "the process tree was killed");
  },
);

test("the startup sweep removes leftovers only", async (t) => {
  const dir = tempDir(t);
  const uuid = (n) => `0000000${n}-1111-4222-8333-444444444444`;
  const now = Date.now();
  const files = {
    deadPid: `joty-run-4242-${uuid(1)}.sql`,
    livePid: `joty-run-777-${uuid(2)}.sql`,
    livePidOld: `joty-run-777-${uuid(3)}.sql`,
    ownUntracked: `joty-run-${process.pid}-${uuid(4)}.sql`,
    legacyOld: `joty-run-${uuid(5)}.sql`,
    legacyNew: `joty-run-${uuid(6)}.sql`,
    unrelated: "joty-run-notes.sql",
    otherApp: `other-${uuid(7)}.sql`,
  };
  for (const name of Object.values(files)) fs.writeFileSync(path.join(dir, name), "select 1");
  const old = new Date(now - STALE_TEMP_MS - 60000);
  for (const key of ["livePidOld", "legacyOld"])
    fs.utimesSync(path.join(dir, files[key]), old, old);

  const removed = await sweepTempFiles({ tmpDir: dir, now, isAlive: (pid) => pid === 777 });
  assert.equal(removed, 4);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    [files.livePid, files.legacyNew, files.unrelated, files.otherApp].sort(),
  );
  assert.equal(await sweepTempFiles({ tmpDir: path.join(dir, "missing") }), 0);
});
