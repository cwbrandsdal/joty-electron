# Joty

Joty is a desktop notes app for fast, keyboard-first note capture and organization.

## Account Access

Joty uses the shared MTN Auth single sign-on through WorkOS AuthKit. Create an account at
[MTN Auth](https://mtnauth.com) before opening the app, then sign in with that same account from
the Joty welcome screen.

## Install

Download the latest Windows installer from
[Releases](https://github.com/cwbrandsdal/joty-electron/releases/latest), then run
`Joty-Setup-x.y.z.exe`.

## Run From Source

```powershell
npm install
npm run dev
```

For local development, configure the WorkOS/AuthKit values in `.env.development` or copy
`.env.example` and set:

- `VITE_WORKOS_CLIENT_ID`
- `VITE_WORKOS_REDIRECT_URI`
- `VITE_API_BASE_URL`

## WorkOS Redirect URIs

Add these callback URLs to the WorkOS application:

| Environment | Redirect URI |
|-------------|--------------|
| Electron dev | `http://127.0.0.1:39173/auth/callback` |
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
