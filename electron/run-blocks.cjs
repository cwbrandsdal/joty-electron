// Run blocks: PowerShell and SQL (through sqlcmd) started from a sheet.
// Runs only on an explicit Run, with the signed-in Windows user's rights.
// Never log the code, its output, or connection strings.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");

const SQL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TABLE_ROWS = 10000;
/** sqlcmd column separator: ASCII unit separator, which data almost never contains. */
const SQL_SEPARATOR = "\x1f";

// ---------- executable discovery ----------

/** True for regular files and for Windows app execution aliases (WindowsApps). */
function exists(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function onPath(name, env = process.env) {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir.replace(/^"|"$/g, ""), name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function programFiles(env = process.env) {
  return [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter(Boolean);
}

function findPowerShell(env = process.env) {
  const fromPath = onPath("pwsh.exe", env);
  if (fromPath) return fromPath;
  for (const root of programFiles(env)) {
    for (const edition of ["7", "7-preview"]) {
      const candidate = path.join(root, "PowerShell", edition, "pwsh.exe");
      if (exists(candidate)) return candidate;
    }
  }
  if (env.LOCALAPPDATA) {
    const alias = path.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe");
    if (exists(alias)) return alias;
  }
  const windowsPowerShell = path.join(
    env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return exists(windowsPowerShell) ? windowsPowerShell : null;
}

function sortedVersionDirs(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /^\d+$/.test(name))
      .sort((a, b) => Number(b) - Number(a))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function findSqlcmd(env = process.env) {
  const fromPath = onPath("sqlcmd.exe", env);
  if (fromPath) return fromPath;
  for (const root of programFiles(env)) {
    const server = path.join(root, "Microsoft SQL Server");
    const candidates = [
      ...sortedVersionDirs(path.join(server, "Client SDK", "ODBC")).map((d) =>
        path.join(d, "Tools", "Binn", "SQLCMD.EXE"),
      ),
      ...sortedVersionDirs(server).map((d) => path.join(d, "Tools", "Binn", "SQLCMD.EXE")),
      path.join(root, "SqlCmd", "sqlcmd.exe"),
    ];
    const found = candidates.find(exists);
    if (found) return found;
  }
  if (env.LOCALAPPDATA) {
    const winget = path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "sqlcmd.exe");
    if (exists(winget)) return winget;
  }
  return null;
}

let availableCache = null;
function available() {
  if (!availableCache || Date.now() - availableCache.at > 60_000) {
    availableCache = { at: Date.now(), powershell: findPowerShell(), sqlcmd: findSqlcmd() };
  }
  return { powershell: availableCache.powershell, sqlcmd: availableCache.sqlcmd };
}

/** Which sqlcmd: the ODBC tool (and its major version) or the Go rewrite. */
const variants = new Map();
function sqlcmdVariant(exe) {
  if (variants.has(exe)) return variants.get(exe);
  const pending = new Promise((resolve) => {
    execFile(exe, ["-?"], { windowsHide: true, timeout: 10000 }, (_error, stdout, stderr) => {
      const help = `${stdout ?? ""}${stderr ?? ""}`;
      if (/--[a-z]/.test(help) && !/Version \d+\.\d+\.\d+\.\d+ NT/.test(help)) {
        resolve({ kind: "go", major: 0 });
      } else {
        const match = /Version (\d+)\./.exec(help);
        resolve({ kind: "odbc", major: match ? Number(match[1]) : 0 });
      }
    });
  });
  variants.set(exe, pending);
  return pending;
}

// ---------- connection strings ----------

const KEY_ALIASES = {
  server: ["server", "data source", "address", "addr", "network address"],
  database: ["database", "initial catalog"],
  user: ["user id", "uid", "user", "username", "user name"],
  password: ["password", "pwd"],
  integrated: ["integrated security", "trusted_connection", "trusted connection"],
  encrypt: ["encrypt"],
  trustServerCertificate: ["trustservercertificate", "trust server certificate"],
  timeout: ["connect timeout", "connection timeout", "timeout"],
  applicationIntent: ["applicationintent", "application intent"],
  multiSubnetFailover: ["multisubnetfailover", "multi subnet failover"],
};
const KEY_LOOKUP = new Map(
  Object.entries(KEY_ALIASES).flatMap(([field, keys]) => keys.map((k) => [k, field])),
);

/** Tokenize an ADO.NET / ODBC connection string into [key, value] pairs. */
function tokenizeConnectionString(input) {
  const pairs = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && (input[i] === ";" || /\s/.test(input[i]))) i++;
    if (i >= n) break;
    let key = "";
    while (i < n) {
      if (input[i] === "=") {
        if (input[i + 1] === "=") {
          key += "=";
          i += 2;
          continue;
        }
        break;
      }
      if (input[i] === ";") break;
      key += input[i++];
    }
    if (input[i] !== "=")
      throw new Error(`The connection string has no value for “${key.trim()}”.`);
    i++;
    while (i < n && input[i] !== ";" && /\s/.test(input[i])) i++;
    let value = "";
    const quote = input[i];
    if (quote === '"' || quote === "'" || quote === "{") {
      const close = quote === "{" ? "}" : quote;
      i++;
      let closed = false;
      while (i < n) {
        if (input[i] === close) {
          if (input[i + 1] === close) {
            value += close;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += input[i++];
      }
      if (!closed) throw new Error("The connection string has an unclosed quote.");
      while (i < n && input[i] !== ";") {
        if (!/\s/.test(input[i])) throw new Error("Unexpected text after a quoted value.");
        i++;
      }
    } else {
      while (i < n && input[i] !== ";") value += input[i++];
      value = value.trim();
    }
    pairs.push([key.trim().toLowerCase().replace(/\s+/g, " "), value]);
  }
  return pairs;
}

const truthy = (v) => /^(true|yes|1|sspi)$/i.test(v.trim());

/** The parts of a SQL Server connection string that sqlcmd understands. */
function parseConnectionString(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("A connection string is needed.");
  const cfg = {};
  for (const [key, value] of tokenizeConnectionString(input)) {
    const field = KEY_LOOKUP.get(key);
    if (field) cfg[field] = value; // Later keys win, as in SqlConnectionStringBuilder.
  }
  if (!cfg.server) throw new Error("The connection string has no Server or Data Source.");
  const result = { server: cfg.server, database: cfg.database || null };
  result.integrated = cfg.integrated !== undefined ? truthy(cfg.integrated) : !cfg.user;
  if (!result.integrated) {
    if (!cfg.user) throw new Error("The connection string has no User Id.");
    result.user = cfg.user;
    result.password = cfg.password ?? "";
  }
  if (cfg.encrypt !== undefined) {
    const v = cfg.encrypt.trim().toLowerCase();
    if (["true", "yes", "mandatory"].includes(v)) result.encrypt = "mandatory";
    else if (["false", "no", "optional"].includes(v)) result.encrypt = "optional";
    else if (v === "strict") result.encrypt = "strict";
    else throw new Error(`Unknown Encrypt value “${cfg.encrypt}”.`);
  }
  if (cfg.trustServerCertificate !== undefined) {
    result.trustServerCertificate = truthy(cfg.trustServerCertificate);
  }
  if (cfg.timeout !== undefined) {
    const seconds = Number(cfg.timeout);
    if (Number.isInteger(seconds) && seconds >= 0 && seconds <= 65534) result.timeout = seconds;
  }
  if (cfg.applicationIntent && /^readonly$/i.test(cfg.applicationIntent.replace(/\s/g, ""))) {
    result.readOnlyIntent = true;
  }
  if (cfg.multiSubnetFailover !== undefined && truthy(cfg.multiSubnetFailover)) {
    result.multiSubnetFailover = true;
  }
  return result;
}

/** Switches that carry no connection values (encryption, output format). */
function sqlcmdFlags(cfg, variant) {
  const flags = [];
  if (cfg.integrated) flags.push("-E");
  if (cfg.encrypt) {
    if (variant.kind === "go") {
      flags.push("-N", { mandatory: "true", optional: "false", strict: "strict" }[cfg.encrypt]);
    } else if (variant.major >= 18) {
      flags.push({ mandatory: "-Nm", optional: "-No", strict: "-Ns" }[cfg.encrypt]);
    } else if (cfg.encrypt === "mandatory") flags.push("-N");
    else if (cfg.encrypt === "strict") {
      throw new Error("Encrypt=Strict needs sqlcmd 18 or later.");
    }
  }
  if (cfg.trustServerCertificate) flags.push("-C");
  if (cfg.readOnlyIntent) flags.push("-K", "ReadOnly");
  if (cfg.multiSubnetFailover) flags.push("-M");
  // Parse-friendly output: one header per result set with a dashed rule, no
  // padding. Errors (severity 11+) go to stderr; PRINT and "(n rows
  // affected)" stay on stdout; -b makes a failed batch a non-zero exit.
  flags.push("-W", "-r", "0", "-b");
  if (variant.kind === "odbc") flags.push("-f", "65001");
  return flags;
}

const cmdSafe = (value) => !/["%!^\r\n]/.test(value);

/**
 * How to start sqlcmd for a parsed connection: { file, args, env, verbatim }.
 * The password is never an argument; it goes through SQLCMDPASSWORD.
 *
 * ODBC sqlcmd writes piped output in the console's code page (OEM 437/850)
 * and ignores -f for it, so it runs under `cmd /c chcp 65001 && sqlcmd …`.
 * cmd.exe then parses the command line, so every connection value travels in
 * SQLCMD* environment variables and the line holds only fixed switches and
 * the two quoted paths. The Go sqlcmd writes UTF-8 and is started directly.
 */
function sqlcmdLaunch(cfg, { exe, inputFile, variant = { kind: "odbc", major: 16 }, env = {} }) {
  const flags = sqlcmdFlags(cfg, variant);
  const secret = cfg.integrated ? {} : { SQLCMDPASSWORD: cfg.password };
  if (variant.kind === "go") {
    const args = ["-S", cfg.server];
    if (cfg.database) args.push("-d", cfg.database);
    if (!cfg.integrated) args.push("-U", cfg.user);
    args.push("-l", String(cfg.timeout ?? 15), "-s", SQL_SEPARATOR, "-w", "65535", ...flags);
    args.push("-i", inputFile);
    return { file: exe, args, env: { ...env, ...secret }, verbatim: false };
  }
  const values = {
    SQLCMDSERVER: cfg.server,
    SQLCMDLOGINTIMEOUT: String(cfg.timeout ?? 15),
    SQLCMDCOLSEP: SQL_SEPARATOR,
    SQLCMDCOLWIDTH: "65535",
    ...(cfg.database ? { SQLCMDDBNAME: cfg.database } : {}),
    ...(cfg.integrated ? {} : { SQLCMDUSER: cfg.user }),
    ...secret,
  };
  const comspec = path.join(
    env.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "cmd.exe",
  );
  if (process.platform === "win32" && cmdSafe(exe) && cmdSafe(inputFile)) {
    const line = `"chcp 65001>nul && "${exe}" ${flags.join(" ")} -i "${inputFile}""`;
    return {
      file: comspec,
      args: ["/d", "/s", "/c", line],
      env: { ...env, ...values },
      verbatim: true,
    };
  }
  return {
    file: exe,
    args: [...flags, "-i", inputFile],
    env: { ...env, ...values },
    verbatim: false,
  };
}

// ---------- sqlcmd output → tables ----------

const ROWS_AFFECTED = /^\(\d+ rows? affected\)$/;

/**
 * Streaming parser for sqlcmd stdout. A line followed by a dashed rule with
 * the same number of columns starts a table; rows follow until a blank line.
 * Everything else is plain output. Calls emit({type:"table"|"stdout",...}).
 */
function createSqlcmdParser(emit, { separator = SQL_SEPARATOR, maxRows = MAX_TABLE_ROWS } = {}) {
  let pending = null; // a line that might be a header
  let table = null;
  let dropped = 0;
  const cells = (line) => line.split(separator).map((v) => v.replace(/ +$/, ""));
  const isRule = (line, count) => {
    const parts = line.split(separator);
    return (
      parts.length === count &&
      parts.every((p) => /^-*$/.test(p.trim())) &&
      parts.some((p) => p.includes("-"))
    );
  };
  function flushTable() {
    if (!table) return;
    emit({ type: "table", columns: table.columns, rows: table.rows });
    if (dropped) emit({ type: "stdout", text: `(${dropped} more rows not shown)` });
    table = null;
    dropped = 0;
  }
  function plain(line) {
    if (line.includes(separator)) line = line.split(separator).join("  ");
    emit({ type: "stdout", text: line });
  }
  function line(text) {
    text = text.replace(/\r$/, "");
    if (table) {
      if (text === "") return flushTable();
      if (ROWS_AFFECTED.test(text.trim())) {
        flushTable();
        return plain(text);
      }
      const row = cells(text);
      if (row.length === table.columns.length) {
        if (table.rows.length < maxRows) table.rows.push(row);
        else dropped++;
        return;
      }
      flushTable();
    }
    if (pending !== null) {
      const header = pending;
      const columns = cells(header);
      if (isRule(text, columns.length)) {
        pending = null;
        table = { columns, rows: [] };
        return;
      }
      pending = null;
      plain(header);
    }
    if (text === "") return plain(text);
    pending = text;
  }
  function end() {
    if (pending !== null) plain(pending);
    pending = null;
    flushTable();
  }
  return { line, end };
}

/** Splits a byte stream into decoded lines. */
function lineSplitter(encoding, onLine) {
  const decoder = new StringDecoder(encoding);
  let carry = "";
  return {
    write(chunk) {
      const text = carry + decoder.write(chunk);
      const parts = text.split("\n");
      carry = parts.pop();
      for (const part of parts) onLine(part.replace(/\r$/, ""));
    },
    end() {
      const rest = carry + decoder.end();
      carry = "";
      if (rest) onLine(rest.replace(/\r$/, ""));
    },
  };
}

// ---------- processes ----------

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^ELECTRON_/i.test(key) || /^SQLCMD/i.test(key)) delete env[key];
  }
  Object.assign(env, extra);
  return env;
}

/** Kill a process and everything it started (Windows has no process groups). */
function killTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error) child.kill();
    });
  } else {
    child.kill("SIGKILL");
  }
}

function powershellBootstrap(code) {
  // One stdin line: no interactive continuation parsing, and base64 keeps
  // non-ASCII code intact whatever the console input code page is.
  const encoded = Buffer.from(code, "utf8").toString("base64");
  return (
    [
      "$ProgressPreference='SilentlyContinue'",
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      "$OutputEncoding=[Console]::OutputEncoding",
      "if ($PSStyle) { $PSStyle.OutputRendering='PlainText' }",
      `$__jotyCode=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
      "$global:LASTEXITCODE=0",
      "try { . ([ScriptBlock]::Create($__jotyCode)) } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }",
      "exit $(if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 })",
    ].join("; ") + "\n"
  );
}

/**
 * Start a run. Events: {type:"stdout"|"stderr", text} per line,
 * {type:"table", columns, rows}, {type:"exit", code, ms}, {type:"error", message}.
 * Returns cancel().
 */
function startRun(req, onEvent, { exes = available(), tmpDir = os.tmpdir() } = {}) {
  const started = Date.now();
  let child = null;
  let finished = false;
  let cancelled = false;
  let timer = null;
  let bytes = 0;
  let inputFile = null;

  const finish = (event) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (inputFile) fsp.rm(inputFile, { force: true }).catch(() => {});
    onEvent(event);
  };
  const fail = (message) => {
    if (finished) return;
    onEvent({ type: "error", message });
    finish({ type: "exit", code: -1, ms: Date.now() - started });
  };

  function attach(proc, { parser } = {}) {
    child = proc;
    const out = lineSplitter("utf8", (text) =>
      parser ? parser.line(text) : onEvent({ type: "stdout", text }),
    );
    const err = lineSplitter("utf8", (text) => onEvent({ type: "stderr", text }));
    const count = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES && !cancelled) {
        cancelled = true;
        onEvent({ type: "stderr", text: "Stopped: the run printed more than 32 MB." });
        killTree(proc);
        return false;
      }
      return true;
    };
    proc.stdout.on("data", (chunk) => count(chunk) && out.write(chunk));
    proc.stderr.on("data", (chunk) => count(chunk) && err.write(chunk));
    proc.on("error", (error) => fail(`Could not start: ${error.message}`));
    proc.on("close", (code) => {
      out.end();
      parser?.end();
      err.end();
      finish({ type: "exit", code: code ?? -1, ms: Date.now() - started });
    });
  }

  const cancel = () => {
    if (finished || cancelled) return;
    cancelled = true;
    if (child) {
      onEvent({ type: "stderr", text: "Stopped." });
      killTree(child);
    } else {
      fail("Stopped.");
    }
  };

  (async () => {
    if (!req || typeof req.code !== "string") throw new Error("Nothing to run.");
    if (req.language === "powershell") {
      if (!exes.powershell) throw new Error("PowerShell was not found on this computer.");
      const proc = spawn(
        exes.powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
        { windowsHide: true, shell: false, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] },
      );
      attach(proc);
      proc.stdin.on("error", () => {});
      proc.stdin.end(powershellBootstrap(req.code), "utf8");
    } else if (req.language === "sql") {
      if (!exes.sqlcmd)
        throw new Error("sqlcmd was not found. Install the SQL Server command line tools.");
      const cfg = parseConnectionString(req.connectionString ?? "");
      const variant = await sqlcmdVariant(exes.sqlcmd);
      if (cancelled) return fail("Stopped.");
      inputFile = path.join(tmpDir, `joty-run-${randomUUID()}.sql`);
      // UTF-8 with BOM: sqlcmd reads it as Unicode whatever the code page.
      await fsp.writeFile(inputFile, "\ufeff" + req.code.replace(/\r?\n/g, "\r\n") + "\r\n", {
        flag: "wx",
        mode: 0o600,
      });
      if (cancelled) return fail("Stopped.");
      const launch = sqlcmdLaunch(cfg, { exe: exes.sqlcmd, inputFile, variant, env: childEnv() });
      const proc = spawn(launch.file, launch.args, {
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: launch.verbatim,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      attach(proc, { parser: createSqlcmdParser(onEvent) });
      timer = setTimeout(() => {
        if (finished) return;
        cancelled = true;
        onEvent({ type: "stderr", text: "Stopped after 5 minutes." });
        killTree(proc);
      }, SQL_TIMEOUT_MS);
    } else {
      throw new Error("Joty runs PowerShell and SQL blocks.");
    }
  })().catch((error) => fail(error instanceof Error ? error.message : String(error)));

  return cancel;
}

module.exports = {
  SQL_SEPARATOR,
  available,
  findPowerShell,
  findSqlcmd,
  sqlcmdVariant,
  tokenizeConnectionString,
  parseConnectionString,
  sqlcmdLaunch,
  createSqlcmdParser,
  lineSplitter,
  powershellBootstrap,
  startRun,
  killTree,
};
