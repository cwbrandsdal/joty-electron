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

For local development, configure the WorkOS/AuthKit values in `.env.development` or copy
`.env.example` and set:

- `VITE_WORKOS_CLIENT_ID`
- `VITE_WORKOS_REDIRECT_URI`
- `VITE_API_BASE_URL`

## Keyboard Shortcuts (native menu)

| Shortcut                      | Action                               |
| ----------------------------- | ------------------------------------ |
| `Ctrl+K`                      | Quick open (command palette)         |
| `Ctrl+N`                      | New note                             |
| `Ctrl+W`                      | Close tab                            |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab                  |
| `Ctrl+P`                      | Pin/unpin current note               |
| `Ctrl+E`                      | Toggle edit/preview                  |
| `Ctrl+Shift+E`                | Export current note as PDF           |
| `Ctrl+Shift+J`                | Quick capture (global, configurable) |
| `Ctrl+,`                      | Settings                             |
| `Ctrl+F` or `/`               | Focus sidebar search                 |

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

Add these callback URLs to the WorkOS application:

| Environment       | Redirect URI                           |
| ----------------- | -------------------------------------- |
| Electron dev      | `http://127.0.0.1:39173/auth/callback` |
| Packaged Electron | `http://127.0.0.1:39179/auth/callback` |

Optional aliases, useful when testing with alternate hostnames:

- `http://localhost:39173/auth/callback`
- `http://localhost:39179/auth/callback`

The API CORS allow-list must include the matching origins without paths:
`http://127.0.0.1:39173`, `http://localhost:39173`,
`http://127.0.0.1:39179`, and `http://localhost:39179`.

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
