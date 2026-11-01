// End-to-end smoke test of the desktop shell: real Electron, preload and
// built renderer (`npx vite build` first), a throwaway profile and a fake
// account. Exercises every window.joty capability the Platform uses.
// Uses the sibling web repo's Playwright; run with `npm run test:smoke`.
// Set JOTY_SMOKE_SQL to a connection string to include a SQL run, and
// JOTY_SMOKE_CLIP=1 to include an (automated) screen clip of this screen.
// JOTY_SMOKE_CLIPBOARD=mock keeps the system clipboard untouched: the main
// process gets an in-memory clipboard and the secret-clipboard check is skipped.
/* global window, document, getComputedStyle */
import { _electron } from "../../joty-web/node_modules/@playwright/test/index.mjs";
import { MockApi } from "../../joty-web/e2e/mock-api.ts";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, appendFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
/** The app reports the version in package.json (a release bumps it). */
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const electronExe = path.join(root, "node_modules/electron/dist/electron.exe");
const fixture = path.join(root, "scripts/fixtures/smoke-main.cjs");
const shots = process.env.JOTY_SMOKE_SHOTS ?? null;
const mockClipboard = process.env.JOTY_SMOKE_CLIPBOARD === "mock";
const temporary = await mkdtemp(path.join(os.tmpdir(), "joty-desktop-smoke-"));
const profile = path.join(temporary, "profile");
const env = { ...process.env, JOTY_SMOKE_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;

let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name} — ${error?.stack ?? error}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const argFile = path.join(temporary, "from argv.md");
const logFile = path.join(temporary, "app.log");
const textFile = path.join(temporary, "dropped.txt");
const imageFile = path.join(temporary, "dropped.png");
const secondFile = path.join(temporary, "second instance.json");
await writeFile(argFile, Buffer.concat([BOM, Buffer.from("# From argv\r\nLine two\r\n")]));
await writeFile(logFile, Buffer.concat([BOM, Buffer.from("first æ\r\n")]));
await writeFile(textFile, "dropped text\n");
await writeFile(
  imageFile,
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
);
await writeFile(secondFile, '{"second": true}\n');

async function launch({ signedIn, args = [] }) {
  const app = await _electron.launch({
    executablePath: electronExe,
    args: [fixture, ...args],
    env: {
      ...env,
      JOTY_SMOKE_SIGNED_IN: signedIn ? "1" : "0",
      JOTY_SMOKE_PROFILE: signedIn ? `${profile}-signed-in` : profile,
    },
  });
  const errors = [];
  const record = (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text().slice(0, 200));
    });
  };
  app.windows().forEach(record);
  app.on("window", record);
  const main = await until(
    async () => app.windows().find((w) => !w.url().includes("capture=1")),
    "the main window",
  );
  await main.waitForLoadState("domcontentloaded");
  return { app, main, errors };
}

// ---------- Signed out: every bridge capability ----------
{
  const { app, main } = await launch({ signedIn: false, args: [argFile] });
  const joty = (fn, arg) => main.evaluate(fn, arg);

  await check("no application menu (renderer owns shortcuts)", async () => {
    const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu());
    assert(menu === null, "a menu is set");
  });

  await check("bridge surface and version", async () => {
    const info = await joty(() => ({
      version: window.joty.version,
      window: window.joty.window,
      keys: Object.keys(window.joty).sort(),
      files: Object.keys(window.joty.files).sort(),
    }));
    assert(info.version === version, `version ${info.version}, expected ${version}`);
    assert(info.window === "main", info.window);
    return `${info.keys.length} members; files: ${info.files.join(", ")}`;
  });

  await check("frameless window with native caption overlay", async () => {
    const overlay = await joty(() => {
      const wco = navigator.windowControlsOverlay;
      const rect = wco?.getTitlebarAreaRect();
      return {
        visible: wco?.visible,
        right: rect && window.innerWidth - rect.x - rect.width,
        height: rect?.height,
      };
    });
    assert(overlay.visible === true, "windowControlsOverlay is not visible");
    assert(overlay.right >= 130 && overlay.right <= 150, `caption width ${overlay.right}`);
    assert(overlay.height === 48, `overlay height ${overlay.height}`);
    return `caption buttons ${overlay.right}px, bar ${overlay.height}px`;
  });

  await check("files: argv path is queued until the page subscribes", async () => {
    const paths = await joty(
      () =>
        new Promise((resolve) => {
          const off = window.joty.files.onOpenRequest((p) => {
            off();
            resolve(p);
          });
        }),
    );
    assert(
      paths.length === 1 && paths[0].toLowerCase() === argFile.toLowerCase(),
      JSON.stringify(paths),
    );
  });

  await check("files: open detects BOM, CRLF and size", async () => {
    const f = await joty((p) => window.joty.files.open(p), logFile);
    assert(f.encoding === "UTF-8 BOM", f.encoding);
    assert(f.eol === "CRLF", f.eol);
    assert(f.text === "first æ\n", JSON.stringify(f.text));
    assert(!f.truncated && !f.readOnly, "flags");
    return `${f.encoding}, ${f.eol}, ${f.size} bytes`;
  });

  await check("files: watch delivers appends, own writes do not echo", async () => {
    await joty((p) => {
      window.__events = [];
      window.__unwatch = window.joty.files.watch(p, (e) => window.__events.push(e));
    }, logFile);
    await sleep(300);
    await appendFile(logFile, "second ø\r\nthird\r\n");
    const events = await until(async () => {
      const e = await joty(() => window.__events);
      return e.length ? e : null;
    }, "an append event");
    assert(
      events[0].kind === "append" && events[0].text === "second ø\nthird\n",
      JSON.stringify(events),
    );
    const written = await joty(
      (p) =>
        window.joty.files.write(p, "rewritten æ\nline\n", { encoding: "UTF-8 BOM", eol: "CRLF" }),
      logFile,
    );
    const bytes = await readFile(logFile);
    assert(
      bytes.equals(Buffer.concat([BOM, Buffer.from("rewritten æ\r\nline\r\n")])),
      "bytes on disk",
    );
    assert(written.size === bytes.length, "size");
    await sleep(1500);
    const after = await joty(() => window.__events.length);
    assert(after === 1, `own write echoed (${after} events)`);
    await writeFile(logFile, "replaced by another program\n");
    const replaced = await until(async () => {
      const e = await joty(() => window.__events);
      return e.length > 1 ? e[1] : null;
    }, "a replace event");
    assert(
      replaced.kind === "replace" && replaced.text === "replaced by another program\n",
      JSON.stringify(replaced),
    );
    await rm(logFile);
    const removed = await until(async () => {
      const e = await joty(() => window.__events);
      return e.length > 2 ? e[2] : null;
    }, "a removed event");
    assert(removed.kind === "removed", JSON.stringify(removed));
    await joty(() => window.__unwatch());
    const leftovers = (await readdir(temporary)).filter((n) => n.endsWith(".tmp"));
    assert(!leftovers.length, `temp files left: ${leftovers}`);
  });

  await check("files: recent lists opened and written files", async () => {
    const recent = await joty(() => window.joty.files.recent());
    assert(recent[0].toLowerCase() === logFile.toLowerCase(), JSON.stringify(recent));
  });

  await check("files: drops open text files only", async () => {
    const accepted = await joty(
      ([a, b]) =>
        new Promise((resolve) => {
          const off = window.joty.files.onOpenRequest((paths) => {
            off();
            resolve(paths);
          });
          void window.joty.files.openDropped([a, b]);
        }),
      [textFile, imageFile],
    );
    assert(accepted.length === 1 && accepted[0] === textFile, JSON.stringify(accepted));
  });

  await check("files: second instance forwards its file", async () => {
    const waiting = joty(
      () =>
        new Promise((resolve) => {
          const off = window.joty.files.onOpenRequest((paths) => {
            off();
            resolve(paths);
          });
        }),
    );
    const second = spawn(electronExe, [fixture, secondFile], { env: { ...env }, stdio: "ignore" });
    const exitCode = await new Promise((resolve) => second.on("exit", resolve));
    const paths = await waiting;
    assert(paths[0].toLowerCase() === secondFile.toLowerCase(), JSON.stringify(paths));
    return `second process exited ${exitCode}`;
  });

  await check("files: binary and relative paths are refused", async () => {
    const binary = await joty(
      (p) =>
        window.joty.files.open(p).then(
          () => "opened",
          (e) => e.message,
        ),
      imageFile,
    );
    assert(/binary/.test(binary), binary);
    const relative = await joty(() =>
      window.joty.files.open("notes.txt").then(
        () => "opened",
        (e) => e.message,
      ),
    );
    assert(/full file path/.test(relative), relative);
  });

  await check("run: PowerShell streams lines and exit code", async () => {
    const result = await joty(
      () =>
        new Promise((resolve) => {
          const events = [];
          window.joty.run.start(
            {
              language: "powershell",
              code: "Write-Output 'Blåbær 👋'\n1..3 | ForEach-Object { \"n=$_\" }\nWrite-Error 'bad'\nexit 4",
            },
            (e) => {
              events.push(e);
              if (e.type === "exit") resolve(events);
            },
          );
        }),
    );
    const out = result.filter((e) => e.type === "stdout").map((e) => e.text);
    assert(out.join("|") === "Blåbær 👋|n=1|n=2|n=3", out.join("|"));
    assert(
      result.some((e) => e.type === "stderr"),
      "no stderr",
    );
    assert(result.at(-1).code === 4, `exit ${result.at(-1).code}`);
    const available = await joty(() => window.joty.run.available());
    return `exit 4 in ${result.at(-1).ms} ms; pwsh=${!!available.powershell} sqlcmd=${!!available.sqlcmd}`;
  });

  await check("run: cancel kills the run", async () => {
    const result = await joty(
      () =>
        new Promise((resolve) => {
          const events = [];
          const cancel = window.joty.run.start(
            { language: "powershell", code: "'go'; Start-Sleep 60" },
            (e) => {
              events.push(e);
              if (e.type === "stdout") cancel();
              if (e.type === "exit") resolve(events);
            },
          );
        }),
    );
    assert(result.at(-1).ms < 20000, `took ${result.at(-1).ms} ms`);
    return `stopped after ${result.at(-1).ms} ms`;
  });

  if (process.env.JOTY_SMOKE_SQL) {
    await check("run: SQL result sets become table events", async () => {
      const result = await joty(
        (cs) =>
          new Promise((resolve) => {
            const events = [];
            window.joty.run.start(
              {
                language: "sql",
                connectionString: cs,
                code: "SELECT 1 AS Id, N'æ 👋' AS T;\nPRINT 'note';",
              },
              (e) => {
                events.push(e);
                if (e.type === "exit") resolve(events);
              },
            );
          }),
        process.env.JOTY_SMOKE_SQL,
      );
      const table = result.find((e) => e.type === "table");
      assert(
        table && table.columns.join() === "Id,T" && table.rows[0][1] === "æ 👋",
        JSON.stringify(result),
      );
      assert(result.at(-1).code === 0, `exit ${result.at(-1).code}`);
      // The plaintext query file is gone once the run has ended.
      const pid = await app.evaluate(() => process.pid);
      await until(
        async () =>
          !(await readdir(os.tmpdir())).some((name) => name.startsWith(`joty-run-${pid}-`)),
        "the temp query file to be deleted",
        5000,
      );
    });
  }

  await check("sealed: encrypted round trip", async () => {
    const before = await joty(() => window.joty.sealed.read());
    await joty(() => window.joty.sealed.write('[{"id":"sealed-1","text":"top secret æ"}]'));
    const back = await joty(() => window.joty.sealed.read());
    assert(back === '[{"id":"sealed-1","text":"top secret æ"}]', back);
    const raw = await readFile(path.join(profile, "joty-sealed.bin"));
    assert(!raw.toString("latin1").includes("top secret"), "plaintext on disk");
    return `empty before: ${before === null}; ${raw.length} bytes of ciphertext`;
  });

  await check("window chrome: colours and Mica", async () => {
    await joty(() =>
      window.joty.windowChrome.setColors({ color: "#0d1f31", symbolColor: "#e3ecf5" }),
    );
    const mica = await joty(() => window.joty.windowChrome.setMaterial("mica"));
    const none = await joty(() => window.joty.windowChrome.setMaterial("none"));
    const saved = JSON.parse(await readFile(path.join(profile, "joty-settings.json"), "utf8"));
    assert(saved.windowChrome.color === "#0d1f31", JSON.stringify(saved.windowChrome));
    const bad = await joty(() =>
      window.joty.windowChrome.setColors({ color: "url(x)", symbolColor: "#fff" }).then(
        () => "ok",
        (e) => e.message,
      ),
    );
    assert(/Colours/.test(bad), bad);
    return `mica → ${mica.material} (supported ${mica.supported}), none → ${none.material}`;
  });

  await check("desktop prefs: hotkey changes are validated", async () => {
    const start = await joty(() => window.joty.prefs.get());
    const set = await joty(() =>
      window.joty.prefs.set({ captureHotkey: "Ctrl+Alt+Shift+F9", minimizeToTray: false }),
    );
    assert(
      set.captureHotkey === "Ctrl+Alt+Shift+F9" && !set.captureHotkeyError,
      JSON.stringify(set),
    );
    const registered = await app.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered("Ctrl+Alt+Shift+F9"),
    );
    assert(registered, "not registered");
    const invalid = await joty(() =>
      window.joty.prefs.set({ captureHotkey: "Ctrl+Nope" }).then(
        () => "ok",
        (e) => e.message,
      ),
    );
    assert(/not a key combination/.test(invalid), invalid);
    const kept = await joty(() => window.joty.prefs.get());
    assert(kept.captureHotkey === "Ctrl+Alt+Shift+F9", JSON.stringify(kept));
    return `default Ctrl+Shift+J: ${start.captureHotkeyError ?? "registered"}`;
  });

  await check("capture slip: pre-warmed, shown at the top, hidden on done and blur", async () => {
    const capture = await until(
      async () => app.windows().find((w) => w.url().includes("capture=1")),
      "capture page",
    );
    await capture.evaluate(() => {
      window.__shown = 0;
      window.addEventListener("joty:capture-show", () => window.__shown++);
    });
    const t0 = Date.now();
    await joty(() => window.joty.capture.show());
    const state = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("capture=1"),
      );
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      return {
        visible: win.isVisible(),
        bounds: win.getBounds(),
        top: area.y,
        onTop: win.isAlwaysOnTop(),
      };
    });
    const ms = Date.now() - t0;
    assert(state.visible && state.onTop, JSON.stringify(state));
    assert(
      state.bounds.width === 760 && state.bounds.height === 360 && state.bounds.y === state.top,
      JSON.stringify(state.bounds),
    );
    await until(() => capture.evaluate(() => window.__shown === 1), "the capture-show event");
    const info = await capture.evaluate(() => ({
      window: window.joty.window,
      files: !!window.joty.files,
    }));
    assert(info.window === "capture", info.window);
    const refused = await capture.evaluate(() =>
      window.joty.files.open("C:\\x.txt").then(
        () => "ok",
        (e) => e.message,
      ),
    );
    assert(/Untrusted/.test(refused), refused);
    await capture.evaluate(() => window.joty.capture.done());
    await until(
      () =>
        app.evaluate(
          ({ BrowserWindow }) =>
            !BrowserWindow.getAllWindows()
              .find((w) => w.webContents.getURL().includes("capture=1"))
              .isVisible(),
        ),
      "the slip to hide",
    );
    await joty(() => window.joty.capture.show());
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => !w.webContents.getURL().includes("capture=1"))
        ?.focus(),
    );
    await until(
      () =>
        app.evaluate(
          ({ BrowserWindow }) =>
            !BrowserWindow.getAllWindows()
              .find((w) => w.webContents.getURL().includes("capture=1"))
              .isVisible(),
        ),
      "the slip to hide on blur",
    );
    return `show round trip ${ms} ms; old capture page refused file access`;
  });

  await check("ocr: Windows OCR reads a design screenshot", async () => {
    const shot = "D:/GitHub/Joty/joty-work/design/shots/20-capture.png";
    if (!existsSync(shot)) return "skipped (no sample image)";
    const png = [...(await readFile(shot))];
    const text = await joty((bytes) => window.joty.ocr(new Uint8Array(bytes)), png);
    assert(/Capture/i.test(text), `OCR text: ${text.slice(0, 80)}`);
    return `${text.length} characters, ${text.split("\n").length} lines`;
  });

  if (process.env.JOTY_SMOKE_CLIP === "1") {
    await check("screen clip: overlay, drag, crop and OCR", async () => {
      const pending = joty(() =>
        window.joty
          .screenClip()
          .then(
            (r) =>
              r && { size: r.png.length, sig: Array.from(r.png.slice(0, 4)), text: typeof r.text },
          ),
      );
      const overlay = await until(
        async () => app.windows().find((w) => w.url().endsWith("clip-overlay.html")),
        "the overlay",
      );
      await until(
        () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some(
              (w) => w.getTitle() === "Joty screen clip" && w.isVisible(),
            ),
          ),
        "the overlay to show",
      );
      await overlay.mouse.move(100, 100);
      await overlay.mouse.down();
      await overlay.mouse.move(420, 260, { steps: 5 });
      await overlay.mouse.up();
      // Never leave a full-screen overlay up if the drag did not register.
      const result = await Promise.race([
        pending,
        sleep(15000).then(async () => {
          await overlay.keyboard.press("Escape").catch(() => {});
          throw new Error("the clip did not finish; cancelled with Esc");
        }),
      ]);
      assert(result && result.sig.join() === "137,80,78,71", JSON.stringify(result));
      const mainVisible = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find(
            (w) =>
              w.webContents.getURL().startsWith("app://joty/") &&
              !w.webContents.getURL().includes("capture=1"),
          )
          ?.isVisible(),
      );
      assert(mainVisible, "main window not restored");
      return `${result.size} byte PNG, OCR ${result.text}`;
    });
  }

  await check("updates: unpackaged builds report idle", async () => {
    const state = await joty(() => window.joty.getAppUpdateState());
    assert(state.phase === "unsupported", state.phase);
  });

  await check("openExternal refuses non-web links", async () => {
    const result = await joty(() =>
      window.joty.openExternal("file:///C:/Windows/notepad.exe").then(
        () => "opened",
        (e) => e.message,
      ),
    );
    assert(/Only web and mail/.test(result), result);
  });

  // Synthetic secrets, assembled at runtime so no token-shaped literal is in the file.
  const MIX = "k9Qz7Lm2Xp4Rt8Vw1Ny6Hb3Jc5Fd0GsTeUaYi";
  const fakeConnection = ["Server=db.example.test;User Id=app;Password=", "Tr0ub4dor-n0t-real"];
  const fakeToken = ["ghp", MIX].join("_");
  // Recognized only on a line of its own: the [renderer:main] wrapper hid it (R5).
  const fakeBare = ["Zq8#vL2!", "mK9$wR4p"].join("");
  const mainLog = path.join(profile, "logs", "joty-main.log");

  await check("log: renderer log calls and console errors are written redacted", async () => {
    await joty(
      (text) => window.joty.log("error", `[smoke] sync failed: ${text}`),
      fakeConnection.join(""),
    );
    await main.evaluate((value) => console.error(value), fakeBare);
    await main.evaluate(
      (token) => console.error(`[smoke] request refused for ${token}`),
      fakeToken,
    );
    const text = await until(async () => {
      const log = await readFile(mainLog, "utf8").catch(() => "");
      return log.includes("[smoke] request refused") ? log : null;
    }, "the console error in the log");
    assert(
      !text.includes(fakeConnection[1]) && !text.includes(fakeToken) && !text.includes(fakeBare),
      "a secret in the log",
    );
    assert(/\[renderer:main\] ⟦secret⟧( \(.*\))?\r?\n/.test(text), "no redacted bare console line");
    assert(
      text.includes(
        "[renderer] [smoke] sync failed: Server=db.example.test;User Id=app;Password=⟦secret⟧",
      ),
      "no redacted renderer line",
    );
    assert(/\[smoke\] request refused for ⟦secret⟧/.test(text), "no redacted console line");
  });

  await check("diagnostics copy redacts old log lines (clipboard restored)", async () => {
    if (mockClipboard) {
      const mocked = await app.evaluate(({ clipboard }) =>
        clipboard.readText.toString().includes("held.get"),
      );
      assert(mocked, "the clipboard is not mocked; not touching the system clipboard");
    }
    // Lines as an older, unredacting version would have written them.
    await appendFile(
      mainLog,
      `2026-10-30T09:00:00.000Z WARN  [legacy] ${fakeConnection.join("")}\n` +
        `2026-10-30T09:00:01.000Z ERROR [renderer:main] ${fakeBare} (app://joty/assets/x.js)\n`,
    );
    const saved = await app.evaluate(({ clipboard }) => clipboard.readText());
    const result = await joty(() => window.joty.copyDiagnostics());
    const report = await app.evaluate(({ clipboard }) => clipboard.readText());
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved);
    assert(
      result.ok && report.includes(`Joty ${version}`) && report.includes("Capture hotkey"),
      report.slice(0, 200),
    );
    assert(!report.includes("top secret"), "sealed text in diagnostics");
    assert(
      !report.includes(fakeConnection[1]) &&
        !report.includes(fakeToken) &&
        !report.includes(fakeBare),
      "a secret in diagnostics",
    );
    assert(
      report.includes("[legacy] Server=db.example.test;User Id=app;Password=⟦secret⟧"),
      "legacy line missing",
    );
    return `${result.length} characters`;
  });

  if (mockClipboard) {
    console.log(
      "SKIP clipboard: a secret skips clipboard history and is cleared — needs the system clipboard",
    );
  } else
    await check("clipboard: a secret skips clipboard history and is cleared", async () => {
      const saved = await app.evaluate(({ clipboard }) => clipboard.readText());
      const board = () =>
        app.evaluate(({ clipboard }) => ({
          text: clipboard.readText(),
          history: [...clipboard.readBuffer("CanIncludeInClipboardHistory")],
          cloud: [...clipboard.readBuffer("CanUploadToCloudClipboard")],
        }));
      try {
        const result = await joty(
          (text) => window.joty.clipboard.writeSecret(text, 1500),
          fakeToken,
        );
        const copied = await board();
        assert(copied.text === fakeToken, "the secret is not on the clipboard");
        assert(result.historyExcluded, "the private copy did not take");
        assert(
          copied.history.join() === "0,0,0,0",
          `CanIncludeInClipboardHistory ${copied.history}`,
        );
        assert(copied.cloud.join() === "0,0,0,0", `CanUploadToCloudClipboard ${copied.cloud}`);
        await until(async () => (await board()).text === "", "the clipboard to clear", 5000);
        // Copied over in the meantime: left alone.
        await joty((text) => window.joty.clipboard.writeSecret(text, 1000), fakeToken);
        await app.evaluate(({ clipboard }) => clipboard.writeText("copied later"));
        await sleep(1600);
        assert((await board()).text === "copied later", "cleared something else");
        const refused = await joty(() =>
          window.joty.clipboard.writeSecret("", 1000).then(
            () => "accepted",
            (e) => e.message,
          ),
        );
        assert(/Nothing to copy/.test(refused), refused);
        return `${result.clearAfterMs} ms`;
      } finally {
        await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved);
      }
    });

  await check("zoom keys persist and resize the caption overlay", async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) =>
          w.webContents.getURL().startsWith("app://joty/") &&
          !w.webContents.getURL().includes("capture=1"),
      );
      win.focus();
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "=", modifiers: ["control"] });
    });
    const saved = await until(async () => {
      const s = JSON.parse(await readFile(path.join(profile, "joty-settings.json"), "utf8"));
      return s.zoomFactor !== 1 ? s : null;
    }, "zoom to change");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find(
          (w) =>
            w.webContents.getURL().startsWith("app://joty/") &&
            !w.webContents.getURL().includes("capture=1"),
        )
        .webContents.sendInputEvent({ type: "keyDown", keyCode: "0", modifiers: ["control"] }),
    );
    await until(
      async () =>
        JSON.parse(await readFile(path.join(profile, "joty-settings.json"), "utf8")).zoomFactor ===
        1,
      "zoom reset",
    );
    return `Ctrl+= → ${saved.zoomFactor}, Ctrl+0 → 1`;
  });

  await check("untrusted pages get no bridge", async () => {
    const type = await app.evaluate(
      async ({ BrowserWindow }, preload) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: { preload, sandbox: true, contextIsolation: true },
        });
        await win.loadURL("data:text/html,<p>untrusted</p>");
        const result = await win.webContents.executeJavaScript("typeof window.joty");
        win.destroy();
        return result;
      },
      path.join(root, "electron/preload.cjs"),
    );
    assert(type === "undefined", type);
  });

  await check(
    "closing the window quits (tray off), capture slip does not keep it alive",
    async () => {
      const closed = app.waitForEvent("close", { timeout: 15000 });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find(
            (w) =>
              w.webContents.getURL().startsWith("app://joty/") &&
              !w.webContents.getURL().includes("capture=1"),
          )
          .close(),
      );
      await closed;
    },
  );
}

// ---------- Signed in: the new app in the frameless shell ----------
{
  const { app, main, errors } = await launch({ signedIn: true, args: [textFile] });
  const api = new MockApi([{ title: "Welcome", body: "Hello from the smoke test" }]);
  await main.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await api.install(main);
  await main.reload();
  let mounted = false;
  await check("signed in: the new app mounts with the desktop platform", async () => {
    await until(
      () => main.evaluate(() => !!document.querySelector(".j-loading, .j-app")),
      "the Joty app",
      20000,
    );
    mounted = await until(
      () => main.evaluate(() => !!document.querySelector(".j-app")),
      "the app shell",
      30000,
    ).catch(() => false);
    if (shots) await main.screenshot({ path: path.join(shots, "desktop-signed-in.png") });
    if (!mounted) {
      const calls = [
        ...new Set(api.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`)),
      ].slice(0, 12);
      throw new Error(
        `still "Opening your sheets…" after 30 s; mocked API calls: ${calls.join(", ")}; page errors: ${errors.slice(0, 3).join(" | ") || "none"}`,
      );
    }
    const shell = await main.evaluate(() => {
      const bar = document.querySelector(".j-bar");
      return {
        skin: document.documentElement.dataset.skin ?? null,
        barHeight: bar ? getComputedStyle(bar).height : null,
        dragRegion: bar
          ? getComputedStyle(bar).getPropertyValue("-webkit-app-region") ||
            getComputedStyle(bar).webkitAppRegion
          : null,
      };
    });
    return `${JSON.stringify(shell)}; page errors: ${errors.length ? errors.slice(0, 3).join(" | ") : "none"}`;
  });
  if (mounted) {
    await check("signed in: the argv file opened as a file sheet", async () => {
      await until(
        () => main.evaluate(() => document.body.innerText.includes("dropped")),
        "the file sheet title",
        15000,
      );
      if (shots) await main.screenshot({ path: path.join(shots, "desktop-file-sheet.png") });
    });
  }
  await app.close();
}

await rm(temporary, { recursive: true, force: true }).catch(() => {});
console.log(failures ? `\n${failures} check(s) failed` : "\nAll desktop smoke checks passed");
process.exit(failures ? 1 : 0);
