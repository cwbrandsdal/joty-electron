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

- **Defaults** suit an app that stays open for weeks: minimize-to-tray, launch at login and
  automatic update downloads are on unless you turn them off in Settings → Desktop. Existing
  installs keep whatever they had chosen.
- **Log file**: the main process writes `%APPDATA%\joty-electron\logs\joty-main.log` (rotated at
  1 MB, three generations): startup, settings, auth state transitions (never tokens), sync
  failures reported by the renderer, renderer console errors, crashes and updater events.
- **Copy diagnostics** (Settings → Desktop) puts a report on the clipboard: versions, OS,
  displays, window bounds, settings, sign-in state, update state and the last 200 log lines.
  No note content is included. Paste it when reporting a problem.
- `npm run lint` also runs `scripts/check-shared-deps.mjs`, which fails when the shared runtime
  packages differ from joty-web's installed versions.

## Keyboard Shortcuts (native menu)

| Shortcut                      | Action                                         |
| ----------------------------- | ---------------------------------------------- |
| `Ctrl+K`                      | Quick open (command palette)                   |
| `Ctrl+N`                      | New note                                       |
| `Ctrl+W`                      | Close tab                                      |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab                            |
| `Ctrl+P`                      | Pin/unpin current note                         |
| `Ctrl+E`                      | Cycle preview pane: auto / split / editor only |
| `Ctrl+Shift+E`                | Export current note as PDF                     |
| `Ctrl+Shift+J`                | Quick capture (global, configurable)           |
| `Ctrl+,`                      | Settings                                       |
| `Ctrl+Shift+F` or `/`         | Focus sidebar search (all notes)               |
| `Ctrl+F`                      | Find in the current note (editor)              |

Editor shortcuts (inside the note body): `Ctrl+B` bold · `Ctrl+I` italic · `` Ctrl+` `` inline code ·
`Ctrl+Shift+K` link · `Ctrl+1/2/3` heading level, `Ctrl+0` clear · `Ctrl+Shift+X` toggle task ·
`Ctrl+Shift+L` toggle bullet · typing `*`, `_`, `` ` `` or `~` with a selection wraps it · Enter
continues lists. Tabs: drag to reorder, right-click to pin, middle-click to close, `Alt+←/→`
moves the focused tab. Editor font, size, line width, typewriter and focus modes live in
Settings → Editor.

The menu bar is hidden by default — press `Alt` to reveal it. Accelerators work while it is hidden.

## Desktop Features

Beyond wrapping the web app, the desktop shell adds:

- **System tray** — Open, New Note, Quick Capture, Check for Updates, Quit; optional
  minimize-to-tray (keeps Joty running when the window is closed).
- **Quick capture** — a global hotkey opens a small always-on-top scratch window that posts a
  note to your account and dismisses itself.
- **Deep links** — `joty://note/<id>` and `joty://new` focus the app and open/create a note.
- **Window state** — size, position, and maximized state are remembered across launches.
- **Launch at login**, **zoom persistence**, and **automatic update downloads** — all toggleable
  in Settings → Desktop.
- **Spellcheck** — right-click a misspelling for suggestions and add-to-dictionary.
- **Print / export to PDF** — the current note's rendered preview, via the OS save dialog.

Native preferences are stored in `joty-settings.json` / `joty-window.json` under the app's
`userData` directory.

The shared UI consumes the shell-neutral `JotyAuthProvider` contract. Electron's
`DesktopAuthProvider` adapts the WorkOS SDK to that contract and registers its
access-token provider with the shared API client. This preserves bearer-token
authentication for desktop while the website uses the API's HttpOnly BFF session.

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
