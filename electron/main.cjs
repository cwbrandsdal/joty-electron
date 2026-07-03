const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  shell,
  dialog,
  globalShortcut,
  nativeImage,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { loadSettings, saveSettings, loadWindowState, saveWindowState } = require("./store.cjs");

const PORT = 39179;
const isDev = !app.isPackaged;
const DEV_URL = "http://127.0.0.1:39173";
const PROTOCOL = "joty";

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
let captureWindow = null;
let tray = null;
let updaterConfigured = false;
let isQuitting = false;
let settings = { ...require("./store.cjs").DEFAULT_SETTINGS };
let appUpdateState = {
  phase: "unsupported",
  currentVersion: app.getVersion(),
};

// --- URL classification (auth flow vs the app's own origin) ---

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

function appBaseUrl() {
  return isDev ? DEV_URL : `http://127.0.0.1:${PORT}`;
}

// Strict CSP for the packaged renderer. WorkOS/AuthKit endpoints are needed
// for sign-in; fonts are self-hosted (@fontsource), so no font CDNs. The
// realtime hub and API live on api.joty.io (https + wss for SignalR).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: https: blob:",
  "connect-src 'self' https://api.joty.io wss://api.joty.io https://api.workos.com https://*.authkit.app",
  "frame-src https://api.workos.com https://*.authkit.app",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://api.workos.com https://*.authkit.app",
].join("; ");

function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      let filePath = path.join(root, url.pathname);

      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
      } catch {
        // file doesn't exist — SPA fallback below
      }

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

    // Without this, a squatted port throws an unhandled error while the window
    // is still hidden and the app appears to hang.
    server.on("error", (err) => reject(err));
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Static server running at http://127.0.0.1:${PORT}`);
      resolve(server);
    });
  });
}

// --- Auto-updater ---

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

  updateAppUpdateState({ phase: "idle", currentVersion: app.getVersion() });

  autoUpdater.autoDownload = settings.autoDownloadUpdates;
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

  const check = () =>
    autoUpdater.checkForUpdates().catch((error) => {
      updateAppUpdateState({
        ...appUpdateState,
        phase: "error",
        currentVersion: app.getVersion(),
        error: error instanceof Error ? error.message : String(error),
      });
    });

  setTimeout(check, 3000);
  // Re-check every 6 hours so a long-running install eventually sees updates.
  setInterval(check, 6 * 60 * 60 * 1000);
}

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

// --- Settings application ---

function applySettings() {
  if (!isDev) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  }
  autoUpdater.autoDownload = settings.autoDownloadUpdates;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(settings.zoomFactor || 1);
  }
  registerCaptureShortcut();
}

function registerCaptureShortcut() {
  globalShortcut.unregisterAll();
  const accelerator = settings.quickCaptureShortcut;
  if (!accelerator) return;
  try {
    globalShortcut.register(accelerator, openQuickCapture);
  } catch {
    // An invalid or already-claimed accelerator just means no global hotkey.
  }
}

// --- Renderer messaging ---

function sendMenuAction(action) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("joty:menu-action", action);
}

function focusMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// --- Deep links (joty://note/<id>, joty://new) ---

function handleDeepLink(url) {
  if (!url || !url.startsWith(`${PROTOCOL}://`)) return;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname; // "note" | "new"
    if (host === "new") {
      focusMainWindow();
      sendMenuAction("new-note");
    } else if (host === "note") {
      const id = parsed.pathname.replace(/^\/+/, "");
      focusMainWindow();
      if (id && mainWindow) mainWindow.webContents.send("joty:open-note", id);
    }
  } catch {
    // Malformed deep link — ignore.
  }
}

// --- Quick capture window ---

function openQuickCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.show();
    captureWindow.focus();
    return;
  }

  captureWindow = new BrowserWindow({
    width: 520,
    height: 260,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "Quick capture",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
    show: false,
  });

  captureWindow.loadURL(`${appBaseUrl()}/?capture=1`);
  captureWindow.once("ready-to-show", () => {
    captureWindow.show();
    captureWindow.focus();
  });
  captureWindow.on("blur", () => {
    // Dismiss on focus loss so it behaves like a spotlight popup.
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
  });
  captureWindow.on("closed", () => {
    captureWindow = null;
  });
}

// --- Application menu ---

function buildApplicationMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "New Note", accelerator: "CmdOrCtrl+N", click: () => sendMenuAction("new-note") },
        {
          label: "Quick Capture",
          accelerator: settings.quickCaptureShortcut || undefined,
          click: openQuickCapture,
        },
        { type: "separator" },
        {
          label: "Export Note as PDF…",
          accelerator: "CmdOrCtrl+Shift+E",
          click: () => sendMenuAction("print-pdf"),
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
        { label: "Next Tab", accelerator: "Control+Tab", click: () => sendMenuAction("next-tab") },
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
            sendMenuAction("open-settings");
            checkForAppUpdates().catch(() => {});
          },
        },
        { type: "separator" },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// --- Spellcheck / editing context menu ---

function attachContextMenu(webContents) {
  webContents.on("context-menu", (_event, params) => {
    const template = [];

    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      template.push({ label: suggestion, click: () => webContents.replaceMisspelling(suggestion) });
    }
    if (params.dictionarySuggestions.length > 0) template.push({ type: "separator" });

    if (params.misspelledWord) {
      template.push({
        label: "Add to Dictionary",
        click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      template.push({ type: "separator" });
    }

    if (params.editFlags.canCut) template.push({ role: "cut" });
    if (params.editFlags.canCopy) template.push({ role: "copy" });
    if (params.editFlags.canPaste) template.push({ role: "paste" });
    if (params.editFlags.canSelectAll) template.push({ role: "selectAll" });

    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({
        window: BrowserWindow.fromWebContents(webContents),
      });
    }
  });
}

// --- Tray ---

function trayIcon() {
  const iconPath = path.join(__dirname, "..", "build", "icon.ico");
  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? undefined : image;
}

function createTray() {
  const image = trayIcon();
  tray = image ? new Tray(image) : new Tray(nativeImage.createEmpty());
  tray.setToolTip("Joty");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Joty", click: focusMainWindow },
      {
        label: "New Note",
        click: () => {
          focusMainWindow();
          sendMenuAction("new-note");
        },
      },
      { label: "Quick Capture", click: openQuickCapture },
      { type: "separator" },
      {
        label: "Check for Updates…",
        click: () => {
          focusMainWindow();
          sendMenuAction("open-settings");
          checkForAppUpdates().catch(() => {});
        },
      },
      { type: "separator" },
      {
        label: "Quit Joty",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", focusMainWindow);
}

// --- Window state ---

function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  // Save the normal bounds, not the maximized ones, so un-maximize restores well.
  const bounds = mainWindow.getNormalBounds();
  saveWindowState({ ...bounds, maximized });
}

// --- Main window ---

async function createWindow() {
  const saved = loadWindowState();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 800,
    minHeight: 600,
    title: "Joty",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
    show: false,
  });

  if (saved?.maximized) mainWindow.maximize();

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

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isSelfUrl(url) || isAuthFlowUrl(url)) return;
    const currentUrl = mainWindow.webContents.getURL();
    const withinAuthFlow = isAuthFlowUrl(currentUrl) && !isSelfUrl(currentUrl);
    if (withinAuthFlow && url.startsWith("https:")) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  attachContextMenu(mainWindow.webContents);

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.setZoomFactor(settings.zoomFactor || 1);
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Minimize-to-tray: intercept close unless the app is really quitting.
  mainWindow.on("close", (event) => {
    persistWindowState();
    if (settings.minimizeToTray && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools();
  } else {
    const rendererPath = path.join(app.getAppPath(), "dist", "renderer");
    await startStaticServer(rendererPath);
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  }

  configureAutoUpdater();
}

// --- IPC ---

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
    isQuitting = true;
    setImmediate(() => autoUpdater.quitAndInstall());
  });

  ipcMain.handle("joty:get-settings", async () => settings);
  ipcMain.handle("joty:update-settings", async (_event, partial) => {
    settings = saveSettings({ ...settings, ...partial });
    applySettings();
    return settings;
  });

  ipcMain.handle("joty:print-note-pdf", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    try {
      const data = await mainWindow.webContents.printToPDF({ printBackground: true });
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: "Export note as PDF",
        defaultPath: "note.pdf",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (canceled || !filePath) return { ok: false };
      fs.writeFileSync(filePath, data);
      return { ok: true, filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("joty:is-quick-capture", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win === captureWindow;
  });
  ipcMain.handle("joty:close-quick-capture", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win === captureWindow) win.close();
  });
}

// --- App lifecycle + single-instance ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    focusMainWindow();
    // A deep link launched the second instance (Windows passes it in argv).
    const deepLink = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (deepLink) handleDeepLink(deepLink);
  });

  // macOS delivers deep links via open-url.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(() => {
    settings = loadSettings();

    if (isDev && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }

    Menu.setApplicationMenu(buildApplicationMenu());
    registerIpc();
    createTray();
    registerCaptureShortcut();

    return createWindow().then(() => {
      applySettings();
      // A deep link may have launched the very first instance (Windows).
      const deepLink = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
      if (deepLink) handleDeepLink(deepLink);
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
    persistWindowState();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });

  app.on("window-all-closed", () => {
    // With minimize-to-tray the main window can be hidden, not closed; only
    // quit when the user really asked to (tray → Quit, or non-tray platforms).
    if (isQuitting || !settings.minimizeToTray) {
      if (server) server.close();
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusMainWindow();
  });
}
