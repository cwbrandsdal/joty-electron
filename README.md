# Joty

Joty is a desktop notes app for fast, keyboard-first note capture and organization.

## Account Access

Joty uses the shared MTN Auth single sign-on (powered by WorkOS AuthKit). Create an account at
[MTN Auth](https://mtnauth.com) before opening the app, then sign in with that same account from
the Joty welcome screen.

## Install

Download the latest Windows installer from
[Releases](https://github.com/cwbrandsdal/joty-electron/releases/latest), then run
`Joty-Setup-x.y.z.exe`.

## Repository Layout — Shared Renderer

This repo contains only the **desktop shell** (Electron main process, preload, and the
`src/desktop/` platform glue). The React app itself lives in the sibling
[joty-web](https://github.com/cwbrandsdal/joty-web) repo and is consumed directly from
`../joty-web/src` via a Vite alias, so both clones must sit next to each other:

```
<workspace>/
├── joty-web/        ← React app (source of truth for the UI)
└── joty-electron/   ← this repo (desktop shell)
```

Both repos need their dependencies installed.

## Run From Source

```powershell
# one-time: install deps in BOTH repos
cd ..\joty-web; npm install
cd ..\joty-electron; npm install

npm run dev
```

For local development, configure the values in `.env.development` or copy `.env.example` and set:

- `VITE_WORKOS_CLIENT_ID` — public AuthKit client id (used by the main process for sign-in)
- `VITE_API_BASE_URL`

The main process reads them from the `.env` files when running from source; `npm run build`
writes them to `electron/desktop-config.json` (gitignored) for packaged builds.

To smoke-test the packaged code path (custom `app://joty` scheme, built renderer) without
packaging: `npm run build`, then set `JOTY_USE_BUILT_RENDERER=1` and run `npm start`.

`@tanstack/react-query`, `@tanstack/react-query-persist-client` and `idb-keyval` are pinned to
the exact versions installed in joty-web: the renderer source is shared, and TypeScript only
unifies duplicate packages when name and version match.

## Authentication & Sessions

Sign-in is owned by the Electron main process (`electron/auth.cjs`), not the renderer:

- The hosted AuthKit page opens in the app window (PKCE, public client, no API key) and
  redirects to a loopback listener on `127.0.0.1:39179` that only exists during sign-in.
- The refresh token is stored encrypted with the OS keychain (`safeStorage`, DPAPI on Windows)
  in `%APPDATA%\joty-electron\joty-auth.bin`. The renderer only ever receives short-lived access
  tokens over IPC (`window.joty.auth`).
- Tokens refresh proactively a minute before expiry, also while the window is hidden, after
  sleep/resume, screen unlock, and whenever the window regains focus.
- Only a terminal WorkOS `invalid_grant` signs you out. Offline periods, timeouts, 5xx and
  429 keep the session and retry with backoff (1 s, 3 s, 8 s, then up to 10 min), so a lost
  refresh response is replayed inside WorkOS's 30-second grace window.
- Signed out is never triggered by navigation: the app shows its landing page with a Sign in
  button instead of bouncing to WorkOS on its own.

Notes are local-first (see joty-web `docs/architecture.md`): edits, pins, archiving, deletes,
tags and folder moves are saved locally and synced in the background, a complete copy of your
notes is kept for offline search and quick-open, the last-known notes render before the network
answers, and quick capture works offline.

## Defaults & Diagnostics

- **Defaults** suit an app that stays open for weeks: minimize-to-tray, launch at login (started
  hidden in the tray) and automatic update downloads are on unless turned off in the Desktop
  group of `settings.joty`. Existing installs keep whatever they had chosen.
- **Log file**: the main process writes `%APPDATA%\joty-electron\logs\joty-main.log` (rotated at
  1 MB, three generations): startup, settings, auth state transitions (never tokens), sync
  failures reported by the renderer, renderer console errors, crashes and updater events. Run
  blocks, file contents, OCR text and connection strings are never logged. As a backstop every
  entry is redacted before it is written or mirrored to the console (see
  [Secrets in logs, diagnostics and the clipboard](#secrets-in-logs-diagnostics-and-the-clipboard)).
- **Copy diagnostics** puts a report on the clipboard: versions, OS and Mica support, displays,
  window bounds, settings, capture hotkey status, sign-in state, sealed-store and run-block
  availability, update state and the last 200 log lines. No note content is included, and the
  whole report is redacted again, log lines from older versions included.
- `npm run lint` also runs `scripts/check-shared-deps.mjs`, which fails when the shared runtime
  packages differ from joty-web's installed versions. `tsconfig.app.json` maps `react` and
  `react-dom` types to this project's copy (the TypeScript counterpart of Vite's `dedupe`).

## Window and Keyboard

The main window is frameless (`titleBarStyle: "hidden"` with a 48 px `titleBarOverlay`): the web
app's bar is the title bar and drag region, and Windows draws its own caption buttons (Snap
layouts, double-click to maximize) at the right. The web app reports skin changes through
`platform.windowChrome.setColors()` / `setMaterial()`; the caption buttons follow, and the
Vellum skin turns on Windows 11 Mica (22H2+; falls back to the skin colour elsewhere). The last
colours are remembered so the next launch paints the right colours before the page loads.

There is no application menu: the web app owns its shortcuts (`Ctrl+K`, `Ctrl+N`, `Ctrl+W`,
`Ctrl+Tab`, `Ctrl+S`, `Ctrl+O`, `Alt+1…5`…; see the concept's keyboard table). The shell keeps
only:

| Shortcut                       | Action                                                      |
| ------------------------------ | ----------------------------------------------------------- |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset (remembered; the caption bar follows) |
| `Ctrl+Shift+I`                 | DevTools, when running from source                          |
| `Ctrl+Shift+J` (configurable)  | Capture slip from any app (global)                          |

While Joty's own window is focused, `Ctrl+Shift+J` goes to the web app (its in-app capture).
If another app already holds the capture hotkey, `desktopPrefs.get()` reports
`captureHotkeyError` and the tray's **Capture** still works.

## File Sheets

Files open as file sheets in the web app: from **Open with**, the command line (first launch or
while running), a second instance, the open dialog (`platform.files.pick()`), or by dropping
them on the window. Dropped files open only when they are text (known text extensions open
straight away, unknown ones are sniffed for binary content); other drops go to the page.

- **Encodings**: UTF-8 (with or without BOM), UTF-16 LE/BE with BOM, and Windows-1252 when the
  bytes are not valid UTF-8. Text reaches the page with `\n` line endings; the file's ending
  (`LF`, `CRLF`, `CR`, by majority) and encoding are reported, and writes restore both, BOM
  included. Windows-1252 refuses characters it cannot hold instead of replacing them.
- **Writes** are atomic: a temp file in the same folder, fsync, rename over the original (retried
  while antivirus or indexers hold the file). On failure the original is untouched.
- **Large files**: over 50 MB only the last ~5 MB is loaded, read-only, starting at a line.
- **Following**: `files.watch()` sends appended text as `append`, truncation, rotation and
  rewrites as `replace`, and deletion as `removed`. The parent folder is watched and a 1 s stat
  poll catches what Windows' watcher misses. Joty's own writes do not echo back.
- `files.recent()` keeps the last 20 opened or written paths (`joty-recent.json`).

The installer registers Joty under **Open with** for `.txt .log .md .markdown .json .jsonc .csv
.tsv .xml .yml .yaml .ini .conf .cfg .env .ps1 .psm1 .sql .cs .ts .js .py .sh .bat .cmd`
without becoming the default app for any of them: `build/installer.nsh` writes only the
`Joty.TextFile` ProgID, each extension's `OpenWithProgids` entry and `Applications\Joty.exe`.
electron-builder's `fileAssociations` is deliberately not used, because its NSIS macro sets each
extension's default class. Uninstalling removes only Joty's entries; the install also clears
defaults that Joty 1.x set for `.txt .log .md .markdown`.

## Run Blocks

`platform.run` runs a sheet's PowerShell or SQL block on an explicit Run, with the Windows
user's rights:

- **PowerShell**: `pwsh.exe` (PATH, Program Files, the Store alias), else Windows PowerShell 5.1,
  with `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -`. The code goes
  through stdin as one line (base64), output is UTF-8, and the exit code is the script's.
- **SQL**: `sqlcmd` (PATH, the ODBC and SQL Server tool folders, Go sqlcmd). The connection
  string (`Server`/`Data Source`, `Database`/`Initial Catalog`, `User Id`/`UID`,
  `Password`/`PWD`, `Integrated Security`/`Trusted_Connection`, `Encrypt`,
  `TrustServerCertificate`, `Connect Timeout`) is parsed in the main process. ODBC sqlcmd runs
  under `cmd /c chcp 65001` (it otherwise writes piped output in the OEM code page); every
  connection value, the password included, travels in `SQLCMD*` environment variables, never on
  the command line. Result sets become `table` events, PRINT and row counts are text, errors go
  to stderr. Runs stop after 5 minutes.
- Output streams line by line; cancel kills the process tree (`taskkill /T /F`). Output over
  32 MB stops the run; tables show at most 10,000 rows.
- **The query file**: sqlcmd reads the query from a file, so a SQL run writes it in plaintext to
  `%TEMP%\joty-run-<pid>-<uuid>.sql` (UTF-8 with BOM, exclusive create). It is deleted when the
  run ends on every path (exit, failure, a spawn that fails, cancel, the 5-minute limit, a
  cancel while it is still being written), synchronously at quit after sqlcmd is killed, on
  process exit, and at the next start for any a crash left behind (files of processes that are
  gone, or older than 10 minutes; another running Joty's files are left alone).
- **The password stays in `SQLCMDPASSWORD`**, on purpose. A command line is readable by every
  process of the user and lands in process-creation auditing (event 4688, EDR); a process's
  environment needs rights to open and read that process. sqlcmd takes a password only from
  `-P`, `SQLCMDPASSWORD` or an interactive console prompt, so the environment is the narrowest
  channel it offers. It is set only in the sqlcmd child's environment (and inherited by anything
  that sqlcmd starts), never in Joty's own.

## Secrets in Logs, Diagnostics and the Clipboard

The desktop side of phase 1 ("stop the leaks") of the secrets design (joty-work
`design/06-secrets.md`):

- **One detector.** `scripts/build-secrets.mjs` bundles joty-web's
  `src/joty/engine/secrets.ts` with esbuild into `electron/generated/secrets.cjs` (generated,
  gitignored, packaged with `electron/**`). It runs in `npm run build` and before `npm test`,
  `npm start`, `npm run dev` and `npm run test:smoke` (or `npm run build:secrets`), so the main
  process always uses the detection the editor uses, never a copied list of patterns.
- **Redacted logs.** `electron/redact.cjs` replaces every detected value with `⟦secret⟧`. Every
  log entry (strings, JSON-serialized objects, Error stacks, renderer `joty.log` calls, renderer
  console warnings and errors with their source URL, window errors, OCR failures) is redacted
  before it reaches the file or the console.
  - _Raw pieces first._ Each logging argument, renderer console message, `joty.log` message and
    Error message (with its `cause` chain, logged as `Caused by:`) is read on its own before tags
    such as `[renderer:main]`, source URLs and timestamps are added, so a value recognized only
    on a line of its own (a pasted password) is still found. Leading `[tag]`s, a trailing
    `(source)` and the last word of a line are also read on their own. Every value learned this
    way is then replaced wherever it appears in the entry: 8+ characters anywhere, a shorter one
    wherever it stands as a whole token (not next to `[A-Za-z0-9_]`), as the web and API
    redactors do. Pass raw values as their own arguments (`log.warn("[x] failed:", error.message)`),
    not inside a template string.
  - _Structured values, value by value._ Before an object argument is written as JSON, every
    string inside it is read on its own: keys, array items, Map and Set entries, an Error's
    message, `cause` and other properties (16 levels deep and 50,000 parts per entry at most;
    a larger value is written `⟦value withheld: too large or unreadable⟧`, deeper parts
    `⟦omitted⟧`, cycles `⟦circular⟧`). JSON found in text (a logged response body, JSON inside
    a JSON string) is parsed and read the same way, then rewritten with its strings redacted. A
    line holding JSON that cannot be parsed (cut off, say) is withheld as
    `⟦structured line withheld⟧`.
  - _Whole lines, then the cut._ Detection always reads complete lines. A line over 4,096
    characters (the detector has quadratic postprocessing) is withheld whole as
    `⟦long line withheld, N chars⟧`, never scanned as a prefix. Text is shortened only after
    redaction: entries to 32 KB, `joty.log` messages to 2,000 characters (lines beginning within
    16 KB are read for values first), OCR errors to 300. Lines beginning past those bounds are
    dropped unread. So a cut can never leave the start of, say, a quoted password with spaces.
  - Without the generated detector (a source checkout that skipped the build step) log text is
    withheld, not written unchecked.
- **Redacted diagnostics.** Copy diagnostics redacts its header (auth, update and hotkey errors,
  also read on their own; settings) and the last 200 log lines again, which covers lines an older
  version wrote raw: the timestamp and level, `[renderer:…]`/`[tag]` prefixes and the renderer
  source suffix are set aside for detection, the JSON objects old lines hold are parsed and read
  value by value (a line whose JSON cannot be parsed is withheld), and a value learned anywhere
  in the report is replaced everywhere in it. Over-long old lines are withheld whole.
- **Copying a secret** (`platform.clipboard.writeSecret(text, clearAfterMs)`, main window only;
  `electron/secret-clipboard.cjs`). The text is put on the clipboard, and after `clearAfterMs`
  (clamped to 1 s – 10 min) the clipboard is cleared only if it still holds exactly that text
  (compared by SHA-256, line endings normalized; the text itself is not kept). A newer secret
  takes over the pending clear, and quitting clears at once. Kept out of Windows clipboard
  history:
  - `clipboard.writeBuffer()` empties the clipboard before writing its one format, so Electron
    cannot add `CanIncludeInClipboardHistory` next to text (tested on Electron 43).
  - Chromium marks copies made in an off-the-record profile itself, and an Electron session
    without `persist:` is one. So the copy runs in a hidden page on the in-memory partition
    `joty-secret-clipboard` (created for the copy, about 60 ms, then destroyed). Windows then gets
    `CanIncludeInClipboardHistory` = 0 and `CanUploadToCloudClipboard` = 0 with the text: no
    clipboard history entry (Win+V), no cloud clipboard sync. The smoke test checks both.
  - `ExcludeClipboardContentFromMonitorProcessing`, which some third-party clipboard managers
    honour, is only written for Chromium's own password manager and cannot be set here.
  - If the private copy fails, the text is written with `clipboard.writeText()` (no history
    exclusion; a warning without the value is logged) and is still cleared on time.

## Sealed Sheets, Capture and Screen Clips

- **Sealed sheets** (`platform.sealed`) are one payload encrypted with `safeStorage` (DPAPI) in
  `joty-sealed.bin` under userData, written atomically with the previous file kept as
  `.bak`. Without OS encryption, reads and writes fail; there is no plaintext fallback.
- **Capture slip**: a hidden, transparent, always-on-top window is created at startup with the
  renderer at `?capture=1`. The hotkey places it (760 × 360) at the top of the display under
  the cursor, focuses it and sends `joty:capture-show`; it hides on blur, Esc and after a jot
  (`window.joty.capture.done()`), and is reused, never reloaded.
- **Screen clip** (`platform.screenClip()`): Joty's windows hide, the display under the cursor is
  captured, and a full-screen overlay lets you drag a region (Esc or right-click cancels). The
  crop comes back as PNG with OCR text.
- **OCR** (`platform.ocr()`): Windows' built-in engine through `electron/ocr-win.ps1` in Windows
  PowerShell 5.1 (shipped as a resource). Returns an empty string when no OCR language is
  installed or policy blocks it.

## Other Desktop Features

- **System tray** — Open, New Sheet, Capture, Check for Updates, Quit; minimize-to-tray keeps
  Joty (and the capture hotkey) running when the window is closed.
- **Deep links** — `joty://note/<id>`, `joty://new` and `joty://capture`.
- **Window state** — size, position and maximized state are remembered; positions on a monitor
  that is gone are dropped.
- **Updates** — electron-updater, exposed as `platform.updates` (`progress` is 0–100). Install
  downloads first when automatic downloads are off.
- **Spellcheck** — right-click a misspelling for suggestions and add-to-dictionary.
- **Print / export to PDF** — `window.joty.printNoteToPdf()`.

Native preferences are stored in `joty-settings.json` / `joty-window.json` under the app's
`userData` directory.

`src/desktop/platform.ts` builds the `Platform` object the web app consumes from the
`window.joty` bridge (`electron/preload.cjs`, typed in `src/desktop/electron-api.ts`). The main
window gets every capability; the capture window only version, screen clip, OCR, preferences,
links and diagnostics. The bridge is exposed only to Joty's own origins, and the main process
checks every request's sender (window and top-level frame) and arguments again.

The shared UI consumes the shell-neutral `JotyAuthProvider` contract. Electron's
`DesktopAuthProvider` mirrors the main-process session and registers its access-token provider
with the shared API client.

## Verification

- `npm test` — unit tests for encodings, line endings, atomic writes, large files, file
  following, connection strings, sqlcmd output parsing, PowerShell runs and cancel, temp query
  file cleanup (end, spawn failure, cancel, quit, startup sweep), log and diagnostics redaction,
  the secret clipboard's clear logic, the sealed store, and colour handling.
- `npm run test:smoke` (after `npm run build`) — launches the real shell with the built
  renderer, a throwaway profile and a fake account through the sibling joty-web Playwright, and
  exercises every bridge capability, the capture slip, OCR and the signed-in app, including log
  and diagnostics redaction and the secret clipboard (history formats and the timed clear). Set
  `JOTY_SMOKE_SQL` to a connection string to include a SQL run (for example
  `Server=(localdb)\MSSQLLocalDB;Trusted_Connection=Yes`), and `JOTY_SMOKE_CLIP=1` to
  include an automated screen clip. `JOTY_SMOKE_CLIPBOARD=mock` leaves the system clipboard
  alone: the main process gets an in-memory clipboard (Copy diagnostics is still checked) and the
  secret-clipboard check, which needs the real one, is skipped. Remove `ELECTRON_RUN_AS_NODE`
  from the environment first.

## WorkOS Redirect URIs

Add this callback URL to the WorkOS application (used from source and packaged alike):

| Environment | Redirect URI                           |
| ----------- | -------------------------------------- |
| Desktop     | `http://127.0.0.1:39179/auth/callback` |

The API CORS allow-list must include the renderer origins: `app://joty` (packaged) and
`http://127.0.0.1:39173` (Vite dev server). Both are in joty-api's default configuration.

## Build

```powershell
npm run build
npm run dist:win
```

The packaged Windows build is written to `release/`.

## Releases & CI

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which checks out **both** repos,
builds, and publishes the installer to GitHub Releases. Cross-repo access uses the
`JOTY_WEB_SSH_KEY` secret — the private half of a read-only deploy key registered on joty-web
(already configured; rotate by generating a new keypair, updating the deploy key and secret).

### Code signing (optional, recommended)

Builds are unsigned until a certificate is configured. To enable signing, set the
`CSC_LINK` (base64 PFX or URL) and `CSC_KEY_PASSWORD` repo secrets — electron-builder picks
them up automatically and signs both the installer and the auto-update artifacts. Until then,
Windows SmartScreen will warn on first install.
