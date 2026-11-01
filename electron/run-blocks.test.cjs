const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  SQL_SEPARATOR,
  createSqlcmdParser,
  findPowerShell,
  parseConnectionString,
  powershellBootstrap,
  sqlcmdLaunch,
  startRun,
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
