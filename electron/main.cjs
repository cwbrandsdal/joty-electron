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
  protocol,
  screen,
  clipboard,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const { loadSettings, saveSettings, loadWindowState, saveWindowState } = require("./store.cjs");
const { loadDesktopConfig } = require("./desktop-config.cjs");
const { AuthManager } = require("./auth.cjs");
const log = require("./log.cjs");

// Loopback port registered with WorkOS as the desktop redirect URI. It is
// only listened on while a sign-in is in progress (see auth.cjs).
const AUTH_CALLBACK_PORT = 39179;
// The packaged renderer is served from its own origin instead of a local HTTP
// port: no port collisions, a stable storage origin, and no need for the
// WorkOS browser SDK's dev mode.
const APP_SCHEME = "app";
const APP_HOST = "joty";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
// Running from source loads the Vite dev server unless told to use the built
// renderer (handy for smoke-testing the packaged code path unpackaged).
const useBuiltRenderer = app.isPackaged || process.env.JOTY_USE_BUILT_RENDERER === "1";
const isDev = !useBuiltRenderer;
const DEV_URL = "http://127.0.0.1:39173";
const PROTOCOL = "joty";
const desktopConfig = loadDesktopConfig({ isPackaged: app.isPackaged });

// Must run before app.whenReady(): makes app:// behave like https:// for
// storage, fetch, CORS and service workers.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

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

let auth = null;
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
      (parsed.hostname === "127.0.0.1" && parsed.port === String(AUTH_CALLBACK_PORT))
    );
  } catch {
    return false;
  }
}

const SELF_ORIGINS = new Set(isDev ? [DEV_URL, APP_ORIGIN] : [APP_ORIGIN]);

function isSelfUrl(url) {
  try {
    return SELF_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

function appBaseUrl() {
  return isDev ? DEV_URL : APP_ORIGIN;
}

function apiOrigins() {
  try {
    const api = new URL(desktopConfig.apiBaseUrl);
    const ws = api.protocol === "https:" ? "wss:" : "ws:";
    return [api.origin, `${ws}//${api.host}`];
  } catch {
    return ["https://api.joty.io", "wss://api.joty.io"];
  }
}

// Strict CSP for the packaged renderer. Sign-in happens in the main process,
// so the renderer only ever talks to the Joty API (https + wss for SignalR).
// Fonts are self-hosted (@fontsource).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: https: blob:",
  `connect-src 'self' ${apiOrigins().join(" ")}`,
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

let appProtocolRegistered = false;

// Serves dist/renderer at app://joty with an SPA fallback, replacing the old
// loopback HTTP server. Hashed assets are cacheable forever; index.html never.
function registerAppProtocol(root) {
  if (appProtocolRegistered) return;
  appProtocolRegistered = true;
  const normalizedRoot = path.resolve(root);
  const indexHtml = path.join(normalizedRoot, "index.html");

  protocol.handle(APP_SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });

    let filePath = path.resolve(normalizedRoot, "." + decodeURIComponent(url.pathname));
    if (!filePath.startsWith(normalizedRoot)) return new Response("Forbidden", { status: 403 });

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) filePath = indexHtml;
    } catch {
      // Not a file — a client-side route; serve the shell.
      filePath = indexHtml;
    }

    try {
      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const headers = {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control":
          filePath === indexHtml ? "no-store" : "public, max-age=31536000, immutable",
      };
      if (ext === ".html") headers["Content-Security-Policy"] = CSP;
      return new Response(data, { status: 200, headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

// --- Authentication (main-process owned; the renderer talks over IPC) ---

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function createAuthManager() {
  const manager = new AuthManager({
    clientId: desktopConfig.workosClientId,
    callbackPort: AUTH_CALLBACK_PORT,
    userDataPath: app.getPath("userData"),
    openAuthUrl: (url) => {
      focusMainWindow();
      mainWindow?.loadURL(url);
    },
    onSignInFinished: (returnTo) => {
      focusMainWindow();
      mainWindow?.loadURL(`${appBaseUrl()}${returnTo}`);
    },
    onStateChange: (state) => {
      log.info(`[auth] state → ${state.status}${state.error ? ` (${state.error})` : ""}`);
      broadcast("joty:auth-state", state);
    },
    logger: log,
  });
  manager.initialize();
  log.info(`[auth] initialized: ${manager.getState().status}`);
  return manager;
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
    log.info(`[updater] downloaded ${info.version}`);
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
    log.warn("[updater] error", error?.message ?? String(error));
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

  attachRendererLogging(captureWindow.webContents, "capture");
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

// --- Diagnostics ---

// Renderer warnings/errors and crashes go to the main log so a broken
// install can be understood from one file. Electron ≥ 35 passes an event
// object with details; older versions pass positional arguments.
function attachRendererLogging(webContents, name) {
  webContents.on("console-message", (event, ...legacy) => {
    const level = event?.level ?? legacy[0];
    const message = event?.message ?? legacy[1];
    const source = event?.sourceId ?? legacy[3];
    const isError = level === "error" || level === 3;
    const isWarning = level === "warning" || level === 2;
    if (!isError && !isWarning) return;
    const text = `[renderer:${name}] ${message}${source ? ` (${source})` : ""}`;
    if (isError) log.error(text);
    else log.warn(text);
  });
  webContents.on("render-process-gone", (_event, details) => {
    log.error(`[renderer:${name}] process gone: ${details.reason} (exit ${details.exitCode})`);
  });
  webContents.on("unresponsive", () => log.warn(`[renderer:${name}] unresponsive`));
  webContents.on("responsive", () => log.info(`[renderer:${name}] responsive again`));
}

function diagnosticsReport() {
  const authState = auth?.getState() ?? { status: "unknown" };
  const lines = [
    `Joty ${app.getVersion()} (${app.isPackaged ? "packaged" : "from source"})`,
    `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`,
    `OS ${process.platform} ${process.getSystemVersion?.() ?? ""} ${process.arch}`,
    `Generated ${new Date().toISOString()}`,
    `User data: ${app.getPath("userData")}`,
    `API: ${desktopConfig.apiBaseUrl}`,
    `Auth: ${authState.status}${authState.user?.email ? ` as ${authState.user.email}` : ""}${authState.error ? `, last error: ${authState.error}` : ""}`,
    `Settings: ${JSON.stringify(settings)}`,
    `Displays: ${screen
      .getAllDisplays()
      .map((d) => `${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y}`)
      .join(" | ")}`,
    `Window: ${
      mainWindow && !mainWindow.isDestroyed() ? JSON.stringify(mainWindow.getBounds()) : "none"
    }`,
    `Update: ${appUpdateState.phase}${appUpdateState.error ? ` (${appUpdateState.error})` : ""}`,
    "",
    `--- last log lines (${log.file ?? "no log file"}) ---`,
    log.tail(200),
  ];
  return lines.join("\n");
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

/**
 * A saved position is only reused when it is still (mostly) on a connected
 * display. Monitor layouts change — docking, RDP, a smaller laptop screen —
 * and restoring coordinates from a monitor that no longer exists puts the
 * window somewhere the user can't see or click. In that case the size is kept
 * and the position is dropped so Electron centers the window.
 */
function usableWindowState(saved) {
  if (!saved) return null;
  if (typeof saved.x !== "number" || typeof saved.y !== "number") return saved;
  const width = saved.width ?? 1280;
  const height = saved.height ?? 800;
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const overlapX =
      Math.min(saved.x + width, workArea.x + workArea.width) - Math.max(saved.x, workArea.x);
    const overlapY =
      Math.min(saved.y + height, workArea.y + workArea.height) - Math.max(saved.y, workArea.y);
    // Require a meaningful chunk on screen, not just a sliver of the frame.
    return overlapX >= Math.min(200, width) && overlapY >= Math.min(120, height);
  });
  if (visible) return saved;
  log.warn("Saved window position is off every display; centering instead", saved);
  return { width, height, maximized: saved.maximized };
}

async function createWindow() {
  const saved = usableWindowState(loadWindowState());
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
  attachRendererLogging(mainWindow.webContents, "main");

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

  // Coming back to the window is a good moment to make sure the token is
  // fresh (covers long idle periods where timers may have been throttled).
  mainWindow.on("focus", () => auth?.onResume());
  mainWindow.on("show", () => auth?.onResume());

  if (isDev) {
    mainWindow.loadURL(`${DEV_URL}/notes`);
    if (!app.isPackaged) mainWindow.webContents.openDevTools();
  } else {
    registerAppProtocol(path.join(app.getAppPath(), "dist", "renderer"));
    mainWindow.loadURL(`${APP_ORIGIN}/notes`);
  }

  configureAutoUpdater();
}

// --- IPC ---

function registerIpc() {
  ipcMain.handle("joty:auth-get-state", () => auth.getState());
  ipcMain.handle("joty:auth-get-access-token", () => auth.getAccessToken());
  ipcMain.handle("joty:auth-sign-in", (_event, returnTo) => auth.signIn(returnTo));
  ipcMain.handle("joty:auth-sign-out", async () => {
    await auth.signOut();
    // Land on the landing page rather than a protected route.
    mainWindow?.loadURL(`${appBaseUrl()}/`);
  });

  ipcMain.handle("joty:log", (_event, level, message) => {
    const text = `[renderer] ${String(message).slice(0, 2000)}`;
    if (level === "error") log.error(text);
    else if (level === "warn") log.warn(text);
    else log.info(text);
  });
  ipcMain.handle("joty:copy-diagnostics", () => {
    const report = diagnosticsReport();
    clipboard.writeText(report);
    return { ok: true, length: report.length, file: log.file };
  });

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

  process.on("uncaughtException", (error) => log.error("[main] uncaught exception", error));
  process.on("unhandledRejection", (reason) => log.error("[main] unhandled rejection", reason));
  app.on("child-process-gone", (_event, details) => {
    log.error(
      `[main] child process gone: ${details.type} ${details.reason} (exit ${details.exitCode})`,
    );
  });

  app.whenReady().then(() => {
    log.init(app.getPath("userData"), { console: !app.isPackaged });
    log.info(
      `Joty ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform} ${process.arch}, ${app.isPackaged ? "packaged" : "source"})`,
    );
    settings = loadSettings();
    log.info("settings", settings);

    if (isDev && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }

    auth = createAuthManager();
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
    log.info("quitting");
    persistWindowState();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    auth?.cancelPendingSignIn();
  });

  app.on("window-all-closed", () => {
    // With minimize-to-tray the main window can be hidden, not closed; only
    // quit when the user really asked to (tray → Quit, or non-tray platforms).
    if (isQuitting || !settings.minimizeToTray) {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusMainWindow();
  });
}
