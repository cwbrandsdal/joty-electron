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

## Build

```powershell
npm run build
npm run dist:win
```

The packaged Windows build is written to `release/`.
