const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const http = require("http");
const fs = require("fs");

const PORT = 39179;
const isDev = !app.isPackaged;
const DEV_URL = "http://127.0.0.1:39173";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

let server = null;
let mainWindow = null;
let updaterConfigured = false;
let appUpdateState = {
  phase: "unsupported",
  currentVersion: app.getVersion(),
};

function isAuthFlowUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "api.workos.com" ||
      parsed.hostname.endsWith(".authkit.app") ||
      (parsed.hostname === "127.0.0.1" && parsed.port === String(PORT))
    );
  } catch {
    return false;
  }
}

const SELF_ORIGINS = new Set(
  isDev ? [DEV_URL, `http://127.0.0.1:${PORT}`] : [`http://127.0.0.1:${PORT}`],
);

function isSelfUrl(url) {
  try {
    return SELF_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

// Strict CSP for the packaged renderer. WorkOS/AuthKit endpoints are needed
// for sign-in; fonts are self-hosted (@fontsource), so no font CDNs.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https://api.joty.io https://api.workos.com https://*.authkit.app",
  "frame-src https://api.workos.com https://*.authkit.app",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://api.workos.com https://*.authkit.app",
].join("; ");

function startStaticServer(root) {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      let filePath = path.join(root, url.pathname);

      // Directory → try index.html inside it
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
      } catch {
        // file doesn't exist — SPA fallback below
      }

      // If file doesn't exist → SPA fallback to index.html
      if (!fs.existsSync(filePath)) {
        filePath = path.join(root, "index.html");
      }

      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const headers = {
          "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        };
        if (ext === ".html") headers["Content-Security-Policy"] = CSP;
        res.writeHead(200, headers);
        res.end(data);
      } catch {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });

    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Static server running at http://127.0.0.1:${PORT}`);
      resolve(server);
    });
  });
}

function updateAppUpdateState(nextState) {
  appUpdateState = nextState;
  mainWindow?.webContents.send("joty:app-update-state", appUpdateState);
}

function normalizeReleaseNotes(releaseNotes) {
  if (!releaseNotes) return undefined;
  if (typeof releaseNotes === "string") return releaseNotes;

  const notes = releaseNotes.map((entry) => entry.note?.trim()).filter(Boolean);

  return notes.length ? notes.join("\n\n") : undefined;
}

function configureAutoUpdater() {
  if (updaterConfigured) return;
  updaterConfigured = true;

  if (!app.isPackaged) {
    updateAppUpdateState({
      phase: "unsupported",
      currentVersion: app.getVersion(),
      error: "App updates are only available in packaged builds.",
    });
    return;
  }

  updateAppUpdateState({
    phase: "idle",
    currentVersion: app.getVersion(),
  });

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    updateAppUpdateState({
      phase: "checking",
      currentVersion: app.getVersion(),
      checkedAt: new Date().toISOString(),
      error: undefined,
    });
  });

  autoUpdater.on("update-available", (info) => {
    updateAppUpdateState({
      phase: "available",
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      checkedAt: new Date().toISOString(),
      error: undefined,
    });
  });

  autoUpdater.on("update-not-available", () => {
    updateAppUpdateState({
      phase: "not-available",
      currentVersion: app.getVersion(),
      checkedAt: new Date().toISOString(),
      availableVersion: undefined,
      releaseName: undefined,
      releaseNotes: undefined,
      percent: undefined,
      bytesPerSecond: undefined,
      transferred: undefined,
      total: undefined,
      downloadedFile: undefined,
      error: undefined,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    updateAppUpdateState({
      ...appUpdateState,
      phase: "downloading",
      currentVersion: app.getVersion(),
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
      error: undefined,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateAppUpdateState({
      phase: "downloaded",
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      checkedAt: new Date().toISOString(),
      downloadedFile: info.downloadedFile,
      percent: 100,
      error: undefined,
    });
  });

  autoUpdater.on("error", (error) => {
    updateAppUpdateState({
      ...appUpdateState,
      phase: "error",
      currentVersion: app.getVersion(),
      error: error?.message ?? String(error),
    });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      updateAppUpdateState({
        ...appUpdateState,
        phase: "error",
        currentVersion: app.getVersion(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 3000);
}

// Shared by the renderer IPC handler and the Help → Check for Updates… menu
// item, so both trigger the exact same code path.
async function checkForAppUpdates() {
  if (!app.isPackaged) {
    updateAppUpdateState({
      phase: "unsupported",
      currentVersion: app.getVersion(),
      error: "App updates are only available in packaged builds.",
    });
    return appUpdateState;
  }

  await autoUpdater.checkForUpdates();
  return appUpdateState;
}

function registerIpc() {
  ipcMain.handle("joty:get-app-update-state", async () => appUpdateState);

  ipcMain.handle("joty:check-for-app-updates", () => checkForAppUpdates());

  ipcMain.handle("joty:download-app-update", async () => {
    if (!app.isPackaged) {
      updateAppUpdateState({
        phase: "unsupported",
        currentVersion: app.getVersion(),
        error: "App updates are only available in packaged builds.",
      });
      return appUpdateState;
    }

    await autoUpdater.downloadUpdate();
    return appUpdateState;
  });

  ipcMain.handle("joty:install-app-update", async () => {
    if (appUpdateState.phase !== "downloaded") return;
    setImmediate(() => {
      autoUpdater.quitAndInstall();
    });
  });
}

// Forwards an application-menu action to the renderer, which subscribes via
// window.joty.onMenuAction (see preload.cjs).
function sendMenuAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("joty:menu-action", action);
}

function buildApplicationMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "New Note",
          accelerator: "CmdOrCtrl+N",
          click: () => sendMenuAction("new-note"),
        },
        {
          label: "Settings",
          accelerator: "CmdOrCtrl+,",
          click: () => sendMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Edit/Preview",
          accelerator: "CmdOrCtrl+E",
          click: () => sendMenuAction("toggle-preview"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(isDev ? [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] : []),
      ],
    },
    {
      label: "Tabs",
      submenu: [
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => sendMenuAction("close-tab"),
        },
        {
          label: "Next Tab",
          accelerator: "Control+Tab",
          click: () => sendMenuAction("next-tab"),
        },
        {
          label: "Previous Tab",
          accelerator: "Control+Shift+Tab",
          click: () => sendMenuAction("prev-tab"),
        },
        { type: "separator" },
        {
          label: "Pin/Unpin Note",
          accelerator: "CmdOrCtrl+P",
          click: () => sendMenuAction("toggle-pin"),
        },
        {
          label: "Quick Open",
          accelerator: "CmdOrCtrl+K",
          click: () => sendMenuAction("toggle-palette"),
        },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Check for Updates…",
          click: () => {
            // Open the settings page so the user sees the check's progress.
            sendMenuAction("open-settings");
            checkForAppUpdates().catch((error) => {
              updateAppUpdateState({
                ...appUpdateState,
                phase: "error",
                currentVersion: app.getVersion(),
                error: error instanceof Error ? error.message : String(error),
              });
            });
          },
        },
        { type: "separator" },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Joty",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    // Intentionally kept hidden: accelerators from the application menu fire
    // even while the bar is hidden, and Alt still reveals it on demand.
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
    show: false,
  });

  // Open external links in default browser. The auth flow is the only thing
  // allowed to take over the window, and only for https targets — note that
  // the app's own 127.0.0.1 origin passes isAuthFlowUrl, so it must not count
  // as "spawned from auth".
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const currentUrl = mainWindow.webContents.getURL();
    const isSpawnedFromAuthFlow = isAuthFlowUrl(currentUrl) && !isSelfUrl(currentUrl);

    if (isAuthFlowUrl(url) || (isSpawnedFromAuthFlow && url.startsWith("https:"))) {
      mainWindow.loadURL(url);
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }

    return { action: "deny" };
  });

  // Same-frame navigation guard: the window may only navigate within the app
  // or into the auth flow. Anything else (e.g. a link inside a note's
  // markdown preview) opens in the system browser instead of replacing the
  // app — which would hand the renderer session to an arbitrary site.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isSelfUrl(url) || isAuthFlowUrl(url)) return;

    const currentUrl = mainWindow.webContents.getURL();
    const withinAuthFlow = isAuthFlowUrl(currentUrl) && !isSelfUrl(currentUrl);
    if (withinAuthFlow && url.startsWith("https:")) return; // IdP redirects mid sign-in

    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // Show window when content is ready (avoids white flash)
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools();
  } else {
    const rendererPath = path.join(app.getAppPath(), "dist", "renderer");
    await startStaticServer(rendererPath);
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  }

  registerIpc();
  configureAutoUpdater();
}

app.whenReady().then(() => {
  // Replace the hidden default menu: its "Close Window" role bound Ctrl+W,
  // which in a tabbed notes app must close a tab, not the whole window.
  Menu.setApplicationMenu(buildApplicationMenu());
  return createWindow();
});

app.on("window-all-closed", () => {
  if (server) server.close();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
