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
  safeStorage,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  loadWindowState,
  saveWindowState,
  loadRecentFiles,
  addRecentFile,
} = require("./store.cjs");
const { loadDesktopConfig } = require("./desktop-config.cjs");
const { AuthManager } = require("./auth.cjs");
const log = require("./log.cjs");
const {
  TEXT_EXTENSIONS,
  fileArguments,
  isTextLikeFile,
  readTextFile,
  writeTextFile,
} = require("./text-files.cjs");
const { createFollower } = require("./file-follow.cjs");
const runBlocks = require("./run-blocks.cjs");
const { createSealedStore } = require("./sealed-store.cjs");
const { runOcr } = require("./ocr.cjs");
const { screenClip } = require("./screen-clip.cjs");
const {
  TITLE_BAR_HEIGHT,
  CAPTION_CONTROLS_WIDTH,
  parseColor,
  overlayColor,
  backgroundColor,
  supportsMica,
} = require("./window-chrome.cjs");

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
const LOGIN_ARG = "--launched-at-login";
const CAPTURE_SIZE = { width: 760, height: 360 };
const desktopConfig = loadDesktopConfig({ isPackaged: app.isPackaged });
const micaSupported = supportsMica();

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
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

let auth = null;
let mainWindow = null;
let captureWindow = null;
let captureLoaded = false;
let captureShowPending = false;
let clipping = false;
let tray = null;
let updaterConfigured = false;
let isQuitting = false;
let settings = { ...DEFAULT_SETTINGS };
let captureHotkey = { accelerator: null, error: null };
let sealedStore = null;
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
    const parsed = new URL(url);
    return SELF_ORIGINS.has(`${parsed.protocol}//${parsed.host}`);
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
    let filePath;
    try {
      url = new URL(request.url);
      filePath = path.resolve(normalizedRoot, "." + decodeURIComponent(url.pathname));
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });
    const relative = path.relative(normalizedRoot, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return new Response("Forbidden", { status: 403 });
    }

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
  broadcast("joty:app-update-state", appUpdateState);
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

function installAppUpdate() {
  if (appUpdateState.phase !== "downloaded") return;
  isQuitting = true;
  setImmediate(() => autoUpdater.quitAndInstall());
}

// --- Settings application ---

function applySettings() {
  if (!isDev) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: [LOGIN_ARG] });
  }
  autoUpdater.autoDownload = settings.autoDownloadUpdates;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(settings.zoomFactor || 1);
  }
}

// --- Capture hotkey ---

const DISABLED_HOTKEYS = new Set(["", "none", "off", "disabled"]);

/** Electron accelerator for a hotkey setting, or null when capture is off. */
function hotkeyAccelerator(value) {
  const text = String(value ?? "").trim();
  if (DISABLED_HOTKEYS.has(text.toLowerCase())) return null;
  return text
    .split("+")
    .map((part) => part.trim())
    .map((part) => (/^win(dows)?$/i.test(part) ? "Super" : part))
    .join("+");
}

/** Ctrl+Shift+J in any spelling: the renderer owns it while Joty is focused. */
function isAppCaptureKey(accelerator) {
  if (!accelerator) return false;
  const parts = accelerator.toLowerCase().split("+").sort().join("+");
  return [
    "commandorcontrol+j+shift",
    "ctrl+j+shift",
    "control+j+shift",
    "cmdorctrl+j+shift",
  ].includes(parts);
}

function toggleCapture() {
  if (
    captureWindow &&
    !captureWindow.isDestroyed() &&
    captureWindow.isVisible() &&
    captureWindow.isFocused()
  ) {
    hideCapture();
  } else {
    showCapture();
  }
}

/** "ok", "taken" (another app holds it) or "invalid" (not an accelerator). */
function registerAccelerator(accelerator) {
  // While Joty's own window is focused the renderer handles Ctrl+Shift+J;
  // the global registration returns when the window loses focus.
  if (isAppCaptureKey(accelerator) && mainWindow?.isFocused()) return "ok";
  try {
    return globalShortcut.register(accelerator, toggleCapture) ? "ok" : "taken";
  } catch {
    return "invalid";
  }
}

/**
 * Register the capture hotkey from settings. On failure the error is kept
 * for desktopPrefs.get(); with `strict` (a settings change) the previous
 * hotkey is restored and the error thrown so the change is refused.
 */
function registerCaptureHotkey(value, { strict = false } = {}) {
  const accelerator = hotkeyAccelerator(value);
  const previous = captureHotkey.accelerator;
  if (accelerator === previous && !captureHotkey.error) return;
  if (previous && globalShortcut.isRegistered(previous)) globalShortcut.unregister(previous);
  if (!accelerator) {
    captureHotkey = { accelerator: null, error: null };
    return;
  }
  const outcome = registerAccelerator(accelerator);
  if (outcome === "ok") {
    captureHotkey = { accelerator, error: null };
    return;
  }
  const error =
    outcome === "invalid"
      ? `${value} is not a key combination Windows can use.`
      : `${value} is already used by another app.`;
  log.warn(`[capture] could not register ${accelerator}: ${outcome}`);
  if (strict) {
    if (previous && registerAccelerator(previous) === "ok") {
      captureHotkey = { accelerator: previous, error: null };
    }
    throw new Error(error);
  }
  captureHotkey = { accelerator: null, error };
}

function onMainFocusChanged(focused) {
  const accelerator = captureHotkey.accelerator;
  if (!accelerator || !isAppCaptureKey(accelerator)) return;
  if (focused) {
    if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
  } else if (
    !globalShortcut.isRegistered(accelerator) &&
    registerAccelerator(accelerator) !== "ok"
  ) {
    captureHotkey = { accelerator: null, error: `${accelerator} is already used by another app.` };
  }
}

/** The hotkey as the web app writes it ("Ctrl+Shift+J"). */
function displayHotkey(value) {
  const accelerator = hotkeyAccelerator(value);
  if (!accelerator) return "none";
  return accelerator
    .split("+")
    .map((part) => (/^(commandorcontrol|cmdorctrl|control|ctrl)$/i.test(part) ? "Ctrl" : part))
    .join("+");
}

// --- Renderer messaging ---

function sendMenuAction(action) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("joty:menu-action", action);
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// --- Deep links (joty://note/<id>, joty://new, joty://capture) ---

function handleDeepLink(url) {
  if (!url || !url.startsWith(`${PROTOCOL}://`)) return;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname; // "note" | "new" | "capture"
    if (host === "new") {
      focusMainWindow();
      sendMenuAction("new-note");
    } else if (host === "capture") {
      showCapture();
    } else if (host === "note") {
      const id = parsed.pathname.replace(/^\/+/, "");
      focusMainWindow();
      if (/^[\w-]{1,128}$/.test(id) && mainWindow)
        mainWindow.webContents.send("joty:open-note", id);
    }
  } catch {
    // Malformed deep link — ignore.
  }
}

// --- Files opened from outside (argv, Open with, second instance, drop) ---

const fileOpen = { ready: false, queue: [] };

function requestOpenFiles(paths) {
  const unique = [...new Set(paths.filter((p) => typeof p === "string" && path.isAbsolute(p)))];
  if (!unique.length) return;
  log.info(`[files] open request for ${unique.length} file(s)`);
  focusMainWindow();
  if (fileOpen.ready && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("joty:files-open-request", unique);
  } else {
    fileOpen.queue.push(...unique);
  }
}

async function openFileArguments(argv, workingDirectory) {
  const candidates = fileArguments(argv, workingDirectory, process.defaultApp);
  const files = [];
  for (const candidate of candidates) {
    try {
      if ((await fs.promises.stat(candidate)).isFile()) files.push(candidate);
    } catch {
      // Not a file (a stray switch value or a deleted path).
    }
  }
  requestOpenFiles(files);
}

// --- File sheets: read, write, follow ---

const pathKey = (p) =>
  process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
const followers = new Map(); // pathKey -> { follower, watches: Set<watchId> }
const watches = new Map(); // watchId -> { key, contents }
const lastBaselines = new Map(); // pathKey -> baseline of the last read/write

function rememberBaseline(filePath, baseline) {
  const key = pathKey(filePath);
  lastBaselines.delete(key);
  lastBaselines.set(key, baseline);
  if (lastBaselines.size > 100) lastBaselines.delete(lastBaselines.keys().next().value);
  followers.get(key)?.follower.rebase(baseline);
}

function rememberRecent(filePath) {
  try {
    addRecentFile(filePath);
    app.addRecentDocument(filePath);
  } catch {
    // Recent files are a convenience.
  }
}

function startWatch(watchId, filePath, contents) {
  const key = pathKey(filePath);
  let entry = followers.get(key);
  if (!entry) {
    entry = { watches: new Set(), follower: null };
    entry.follower = createFollower(filePath, {
      baseline: lastBaselines.get(key),
      onEvent: (event) => {
        for (const id of entry.watches) {
          const watch = watches.get(id);
          if (watch && !watch.contents.isDestroyed()) {
            watch.contents.send("joty:files-watch-event", { watchId: id, event });
          }
        }
      },
    });
    followers.set(key, entry);
  }
  entry.watches.add(watchId);
  watches.set(watchId, { key, contents });
}

function stopWatch(watchId) {
  const watch = watches.get(watchId);
  if (!watch) return;
  watches.delete(watchId);
  const entry = followers.get(watch.key);
  if (!entry) return;
  entry.watches.delete(watchId);
  if (!entry.watches.size) {
    entry.follower.close();
    followers.delete(watch.key);
  }
}

// --- Run blocks ---

const runs = new Map(); // runId -> { cancel, contents }

function startRunFor(runId, req, contents) {
  let queue = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (!queue.length || contents.isDestroyed()) return;
    contents.send("joty:run-events", { runId, events: queue });
    queue = [];
  };
  const cancel = runBlocks.startRun(req, (event) => {
    queue.push(event);
    if (event.type === "exit") {
      runs.delete(runId);
      clearTimeout(timer);
      flush();
    } else if (queue.length >= 500) {
      clearTimeout(timer);
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, 30);
    }
  });
  runs.set(runId, { cancel, contents });
}

/** Forget a renderer's watches and stop its runs (reload, navigation, close). */
function releaseRendererResources(contents) {
  for (const [id, watch] of watches) if (watch.contents === contents) stopWatch(id);
  for (const [id, run] of runs) {
    if (run.contents === contents) {
      run.cancel();
      runs.delete(id);
    }
  }
}

// --- Quick capture window (pre-warmed, hidden between uses) ---

function captureBounds() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const width = Math.min(CAPTURE_SIZE.width, area.width);
  const height = Math.min(CAPTURE_SIZE.height, area.height);
  return { x: Math.round(area.x + (area.width - width) / 2), y: area.y, width, height };
}

function createCaptureWindow() {
  captureLoaded = false;
  captureWindow = new BrowserWindow({
    ...CAPTURE_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    title: "Joty capture",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      // The hidden slip must react instantly to the hotkey.
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [`--joty-version=${app.getVersion()}`, "--joty-window=capture"],
    },
  });
  const win = captureWindow;
  attachRendererLogging(win.webContents, "capture");
  attachContextMenu(win.webContents);
  guardNavigation(win);
  win.webContents.on("did-finish-load", () => {
    captureLoaded = true;
    if (captureShowPending) showCapture();
  });
  win.on("blur", () => {
    if (!clipping) hideCapture();
  });
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideCapture();
    }
  });
  win.on("closed", () => {
    if (captureWindow === win) captureWindow = null;
  });
  win.webContents.on("render-process-gone", () => {
    captureLoaded = false;
    if (!win.isDestroyed()) win.destroy();
    if (captureWindow === win) captureWindow = null;
    setTimeout(() => {
      if (!isQuitting && (!captureWindow || captureWindow.isDestroyed())) createCaptureWindow();
    }, 1000);
  });
  win.loadURL(`${appBaseUrl()}/?capture=1`);
}

function showCapture() {
  if (!captureWindow || captureWindow.isDestroyed()) createCaptureWindow();
  if (!captureLoaded) {
    captureShowPending = true;
    return;
  }
  captureShowPending = false;
  captureWindow.setBounds(captureBounds());
  captureWindow.show();
  captureWindow.moveTop();
  captureWindow.focus();
  captureWindow.webContents.focus();
  captureWindow.webContents.send("joty:capture-show");
}

function hideCapture() {
  captureShowPending = false;
  if (!captureWindow || captureWindow.isDestroyed() || !captureWindow.isVisible()) return;
  captureWindow.hide();
  captureWindow.webContents.send("joty:capture-hide");
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
  const exes = runBlocks.available();
  const lines = [
    `Joty ${app.getVersion()} (${app.isPackaged ? "packaged" : "from source"})`,
    `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`,
    `OS ${process.platform} ${process.getSystemVersion?.() ?? ""} ${process.arch}, Mica ${micaSupported ? "supported" : "unsupported"}`,
    `Generated ${new Date().toISOString()}`,
    `User data: ${app.getPath("userData")}`,
    `API: ${desktopConfig.apiBaseUrl}`,
    `Auth: ${authState.status}${authState.user?.email ? ` as ${authState.user.email}` : ""}${authState.error ? `, last error: ${authState.error}` : ""}`,
    `Settings: ${JSON.stringify(settings)}`,
    `Capture hotkey: ${captureHotkey.accelerator ?? "off"}${captureHotkey.error ? ` (${captureHotkey.error})` : ""}`,
    `Sealed store: ${safeStorage.isEncryptionAvailable() ? "OS encryption available" : "OS encryption unavailable"}`,
    `Run blocks: PowerShell ${exes.powershell ? "found" : "missing"}, sqlcmd ${exes.sqlcmd ? "found" : "missing"}`,
    `Displays: ${screen
      .getAllDisplays()
      .map(
        (d) => `${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y} x${d.scaleFactor}`,
      )
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

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(__dirname, "..", "build", "icon.ico");
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("Joty");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Joty", click: focusMainWindow },
      {
        label: "New Sheet",
        click: () => {
          focusMainWindow();
          sendMenuAction("new-note");
        },
      },
      { label: "Capture", click: showCapture },
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

/** The remembered skin colours, parsed ({ r, g, b, a }). */
function chromeColors() {
  const chrome = settings.windowChrome ?? DEFAULT_SETTINGS.windowChrome;
  const fallback = DEFAULT_SETTINGS.windowChrome;
  return {
    color: parseColor(chrome.color) ?? parseColor(fallback.color),
    symbolColor: parseColor(chrome.symbolColor) ?? parseColor(fallback.symbolColor),
  };
}

/** The title bar overlay follows the bar's CSS height through zoom. */
function overlayOptions() {
  const { color, symbolColor } = chromeColors();
  return {
    color: overlayColor(color),
    symbolColor: overlayColor(symbolColor),
    height: Math.round(TITLE_BAR_HEIGHT * (settings.zoomFactor || 1)),
  };
}

/** Behind the page: the skin's colour, or clear for Mica. */
function windowBackground(material) {
  return material === "mica"
    ? "#00000000"
    : backgroundColor(chromeColors().color, { opaque: true });
}

function applyMaterial(material) {
  if (!mainWindow || mainWindow.isDestroyed()) return "none";
  const effective = material === "mica" && micaSupported ? "mica" : "none";
  if (micaSupported) mainWindow.setBackgroundMaterial(effective);
  // "none" resets the background to white; restore the skin's colour after.
  mainWindow.setBackgroundColor(windowBackground(effective));
  return effective;
}

function setZoom(factor) {
  const zoom = Math.min(3, Math.max(0.5, Math.round(factor * 100) / 100));
  settings = saveSettings({ ...settings, zoomFactor: zoom });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.setZoomFactor(zoom);
  mainWindow.setTitleBarOverlay(overlayOptions());
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/**
 * Keys the shell keeps with no menu bar: zoom, and DevTools when running from
 * source. Everything else (Ctrl+K/S/O/D/E/M/., Alt+digits…) reaches the page.
 */
function handleShellKeys(event, input) {
  if (input.type !== "keyDown" || !input.control || input.alt || input.meta) return;
  const key = input.key.toLowerCase();
  if (!app.isPackaged && input.shift && key === "i") {
    event.preventDefault();
    mainWindow?.webContents.toggleDevTools();
    return;
  }
  if (input.shift && key !== "+") return;
  const current = settings.zoomFactor || 1;
  if (key === "=" || key === "+") {
    event.preventDefault();
    setZoom(ZOOM_STEPS.find((z) => z > current + 0.001) ?? current);
  } else if (key === "-") {
    event.preventDefault();
    setZoom([...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? current);
  } else if (key === "0") {
    event.preventDefault();
    setZoom(1);
  }
}

function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const currentUrl = win.webContents.getURL();
    const isSpawnedFromAuthFlow = isAuthFlowUrl(currentUrl) && !isSelfUrl(currentUrl);
    if (
      win === mainWindow &&
      (isAuthFlowUrl(url) || (isSpawnedFromAuthFlow && url.startsWith("https:")))
    ) {
      win.loadURL(url);
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isSelfUrl(url)) return;
    if (win === mainWindow) {
      if (isAuthFlowUrl(url)) return;
      const currentUrl = win.webContents.getURL();
      const withinAuthFlow = isAuthFlowUrl(currentUrl) && !isSelfUrl(currentUrl);
      if (withinAuthFlow && url.startsWith("https:")) return;
    }
    // Includes file:// from a drop the page did not handle.
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}

async function createWindow() {
  const saved = usableWindowState(loadWindowState());
  const material = settings.windowChrome?.material === "mica" && micaSupported ? "mica" : "none";
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 640,
    minHeight: 480,
    title: "Joty",
    icon: iconPath(),
    // Frameless look with the native caption buttons kept (Snap layouts,
    // double-click to maximize); the web app draws the 48 px bar.
    titleBarStyle: "hidden",
    titleBarOverlay: overlayOptions(),
    backgroundColor: windowBackground(material),
    ...(material === "mica" ? { backgroundMaterial: "mica" } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [
        `--joty-version=${app.getVersion()}`,
        "--joty-window=main",
        `--joty-controls-width=${CAPTION_CONTROLS_WIDTH}`,
      ],
    },
    show: false,
  });
  const win = mainWindow;

  if (saved?.maximized) win.maximize();

  guardNavigation(win);
  attachContextMenu(win.webContents);
  win.webContents.on("before-input-event", handleShellKeys);
  win.webContents.on("will-prevent-unload", (event) => {
    // The page asked to confirm leaving (unsaved file edits, say).
    const answer = dialog.showMessageBoxSync(win, {
      type: "warning",
      title: "Unsaved changes",
      message: "Joty has changes that are not written yet. Close anyway?",
      buttons: ["Close", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (answer === 0) event.preventDefault();
    else isQuitting = false;
  });
  attachRendererLogging(win.webContents, "main");

  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomFactor(settings.zoomFactor || 1);
  });
  win.webContents.on("zoom-changed", (_event, direction) => {
    const current = settings.zoomFactor || 1;
    if (direction === "in") setZoom(ZOOM_STEPS.find((z) => z > current + 0.001) ?? current);
    else setZoom([...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? current);
  });
  win.webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    // A reload or navigation drops the page's subscriptions.
    fileOpen.ready = false;
    releaseRendererResources(win.webContents);
  });
  win.webContents.on("destroyed", () => releaseRendererResources(win.webContents));

  // Launched at sign-in with the tray on: stay warm but out of the way.
  const startHidden = process.argv.includes(LOGIN_ARG) && settings.minimizeToTray;
  win.once("ready-to-show", () => {
    if (!startHidden) win.show();
  });

  // Minimize-to-tray: intercept close unless the app is really quitting.
  win.on("close", (event) => {
    persistWindowState();
    if (settings.minimizeToTray && !isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // The hidden capture window would otherwise keep the app alive.
    if (isQuitting || !settings.minimizeToTray) app.quit();
  });

  // Coming back to the window is a good moment to make sure the token is
  // fresh (covers long idle periods where timers may have been throttled).
  win.on("focus", () => {
    auth?.onResume();
    onMainFocusChanged(true);
  });
  win.on("blur", () => onMainFocusChanged(false));
  win.on("show", () => auth?.onResume());

  if (isDev) {
    win.loadURL(`${DEV_URL}/notes`);
  } else {
    win.loadURL(`${APP_ORIGIN}/notes`);
  }

  configureAutoUpdater();
}

// --- IPC ---

const MAX_TEXT_CHARS = 200 * 1024 * 1024;

/** Which of our windows sent this (only top-level frames on Joty's origin). */
function senderKind(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !isSelfUrl(frame.url)) return null;
  if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) {
    return "main";
  }
  if (captureWindow && !captureWindow.isDestroyed() && event.sender === captureWindow.webContents) {
    return "capture";
  }
  return null;
}

function trusted(event, ...kinds) {
  const kind = senderKind(event);
  if (!kind || (kinds.length && !kinds.includes(kind))) throw new Error("Untrusted request.");
  return kind;
}

function handle(channel, kinds, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    trusted(event, ...kinds);
    return handler(event, ...args);
  });
}

function absolutePath(value) {
  if (typeof value !== "string" || value.length > 32767 || !path.isAbsolute(value)) {
    throw new Error("A full file path is required.");
  }
  return path.normalize(value);
}

const validId = (value) => typeof value === "string" && /^[\w-]{8,64}$/.test(value);

function desktopPrefs() {
  return {
    launchAtLogin: !!settings.launchAtLogin,
    minimizeToTray: !!settings.minimizeToTray,
    autoUpdate: !!settings.autoDownloadUpdates,
    captureHotkey: displayHotkey(settings.quickCaptureShortcut),
    captureHotkeyError: captureHotkey.error,
  };
}

function setDesktopPrefs(patch) {
  if (!patch || typeof patch !== "object") throw new Error("Invalid settings.");
  const next = { ...settings };
  for (const [key, field] of [
    ["launchAtLogin", "launchAtLogin"],
    ["minimizeToTray", "minimizeToTray"],
    ["autoUpdate", "autoDownloadUpdates"],
  ]) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== "boolean") throw new Error(`${key} must be true or false.`);
    next[field] = patch[key];
  }
  if (patch.captureHotkey !== undefined) {
    if (typeof patch.captureHotkey !== "string" || patch.captureHotkey.length > 64) {
      throw new Error("Invalid capture hotkey.");
    }
    registerCaptureHotkey(patch.captureHotkey, { strict: true });
    next.quickCaptureShortcut = patch.captureHotkey.trim();
  }
  settings = saveSettings(next);
  applySettings();
  return desktopPrefs();
}

async function pickFiles() {
  const options = {
    title: "Open a file",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Text files", extensions: [...TEXT_EXTENSIONS] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  const opened = [];
  let firstError = null;
  for (const filePath of result.filePaths) {
    try {
      opened.push(await openFile(filePath));
    } catch (error) {
      firstError ??= error;
    }
  }
  if (!opened.length && firstError) throw firstError;
  return opened;
}

async function openFile(filePath) {
  const { result, baseline } = await readTextFile(absolutePath(filePath));
  rememberBaseline(result.path, baseline);
  if (result.path !== filePath) rememberBaseline(filePath, baseline);
  rememberRecent(result.path);
  return result;
}

/** Shrink images beyond the OCR engine's limit (10,000 px on current Windows). */
function ocrReady(png) {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const limit = 9000;
  if (width <= limit && height <= limit) return png;
  const scale = limit / Math.max(width, height);
  return image
    .resize({
      width: Math.floor(width * scale),
      height: Math.floor(height * scale),
      quality: "best",
    })
    .toPNG();
}

function ocrScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "ocr-win.ps1")
    : path.join(__dirname, "ocr-win.ps1");
}

async function ocrPng(png) {
  const ready = ocrReady(png);
  if (!ready) return "";
  return runOcr(ready, { scriptPath: ocrScriptPath(), log });
}

function registerIpc() {
  // Authentication (the main and capture windows both need a token).
  handle("joty:auth-get-state", [], () => auth.getState());
  handle("joty:auth-get-access-token", [], () => auth.getAccessToken());
  handle("joty:auth-sign-in", ["main"], (_event, returnTo) => auth.signIn(returnTo));
  handle("joty:auth-sign-out", ["main"], async () => {
    await auth.signOut();
    // Land on the landing page rather than a protected route.
    mainWindow?.loadURL(`${appBaseUrl()}/`);
  });

  handle("joty:log", [], (_event, level, message) => {
    const text = `[renderer] ${String(message).slice(0, 2000)}`;
    if (level === "error") log.error(text);
    else if (level === "warn") log.warn(text);
    else log.info(text);
  });
  handle("joty:copy-diagnostics", [], () => {
    const report = diagnosticsReport();
    clipboard.writeText(report);
    return { ok: true, length: report.length, file: log.file };
  });
  handle("joty:open-external", [], (_event, url) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error("Invalid link.");
    }
    if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) {
      throw new Error("Only web and mail links open outside Joty.");
    }
    return shell.openExternal(parsed.toString());
  });

  // Updates.
  handle("joty:get-app-update-state", [], async () => appUpdateState);
  handle("joty:check-for-app-updates", ["main"], () => checkForAppUpdates());
  handle("joty:download-app-update", ["main"], async () => {
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
  handle("joty:install-app-update", ["main"], async () => installAppUpdate());

  // Desktop preferences (old settings shape kept for older renderers).
  handle("joty:prefs-get", [], () => desktopPrefs());
  handle("joty:prefs-set", ["main"], (_event, patch) => setDesktopPrefs(patch));
  handle("joty:get-settings", [], async () => settings);
  handle("joty:update-settings", ["main"], async (_event, partial) => {
    const patch = {};
    if (partial && typeof partial === "object") {
      if (typeof partial.launchAtLogin === "boolean") patch.launchAtLogin = partial.launchAtLogin;
      if (typeof partial.minimizeToTray === "boolean")
        patch.minimizeToTray = partial.minimizeToTray;
      if (typeof partial.autoDownloadUpdates === "boolean")
        patch.autoUpdate = partial.autoDownloadUpdates;
      if (typeof partial.quickCaptureShortcut === "string")
        patch.captureHotkey = partial.quickCaptureShortcut;
      if (typeof partial.zoomFactor === "number") setZoom(partial.zoomFactor);
    }
    setDesktopPrefs(patch);
    return settings;
  });

  // Window chrome.
  handle("joty:window-set-colors", ["main"], (_event, colors) => {
    const color = parseColor(colors?.color);
    const symbolColor = parseColor(colors?.symbolColor);
    if (!color || !symbolColor) throw new Error("Colours must be CSS hex or rgb() values.");
    settings = saveSettings({
      ...settings,
      windowChrome: {
        ...settings.windowChrome,
        color: colors.color,
        symbolColor: colors.symbolColor,
      },
    });
    mainWindow.setTitleBarOverlay(overlayOptions());
    // A translucent skin colour (Vellum) is not a usable window background.
    if (settings.windowChrome.material !== "mica" && color.a === 1) {
      mainWindow.setBackgroundColor(windowBackground("none"));
    }
  });
  handle("joty:window-set-material", ["main"], (_event, material) => {
    if (material !== "mica" && material !== "none") throw new Error("Unknown material.");
    const effective = applyMaterial(material);
    settings = saveSettings({ ...settings, windowChrome: { ...settings.windowChrome, material } });
    return { material: effective, supported: micaSupported };
  });

  // File sheets.
  handle("joty:files-pick", ["main"], () => pickFiles());
  handle("joty:files-open", ["main"], (_event, filePath) => openFile(filePath));
  handle("joty:files-write", ["main"], async (_event, filePath, text, opts) => {
    const target = absolutePath(filePath);
    if (typeof text !== "string" || text.length > MAX_TEXT_CHARS)
      throw new Error("Nothing to write.");
    if (!opts || typeof opts.encoding !== "string" || typeof opts.eol !== "string") {
      throw new Error("Encoding and line ending are required.");
    }
    const written = await writeTextFile(target, text, { encoding: opts.encoding, eol: opts.eol });
    rememberBaseline(written.path, written.baseline);
    if (written.path !== target) rememberBaseline(target, written.baseline);
    rememberRecent(written.path);
    return { size: written.size, mtimeMs: written.mtimeMs };
  });
  handle("joty:files-watch", ["main"], (event, watchId, filePath) => {
    if (!validId(watchId)) throw new Error("Invalid watch.");
    stopWatch(watchId);
    startWatch(watchId, absolutePath(filePath), event.sender);
  });
  handle("joty:files-unwatch", ["main"], (_event, watchId) => {
    if (validId(watchId)) stopWatch(watchId);
  });
  handle("joty:files-recent", ["main"], () => loadRecentFiles());
  handle("joty:files-reveal", ["main"], (_event, filePath) => {
    shell.showItemInFolder(absolutePath(filePath));
  });
  handle("joty:files-take-open-requests", ["main"], () => {
    fileOpen.ready = true;
    return fileOpen.queue.splice(0);
  });
  handle("joty:files-dropped", ["main"], async (_event, paths) => {
    if (!Array.isArray(paths)) throw new Error("Invalid drop.");
    const accepted = [];
    for (const candidate of paths.slice(0, 50)) {
      try {
        const filePath = absolutePath(candidate);
        if (await isTextLikeFile(filePath)) accepted.push(filePath);
      } catch {
        // Not a usable path.
      }
    }
    requestOpenFiles(accepted);
    return accepted;
  });

  // Run blocks.
  handle("joty:run-available", ["main"], () => runBlocks.available());
  handle("joty:run-start", ["main"], (event, runId, req) => {
    if (!validId(runId) || runs.has(runId)) throw new Error("Invalid run.");
    if (!req || (req.language !== "powershell" && req.language !== "sql")) {
      throw new Error("Joty runs PowerShell and SQL blocks.");
    }
    if (typeof req.code !== "string" || req.code.length > 1024 * 1024)
      throw new Error("Nothing to run.");
    if (
      req.connectionString != null &&
      (typeof req.connectionString !== "string" || req.connectionString.length > 4096)
    ) {
      throw new Error("Invalid connection string.");
    }
    if (runs.size >= 8) throw new Error("Too many runs at once. Stop one first.");
    startRunFor(
      runId,
      { language: req.language, code: req.code, connectionString: req.connectionString ?? null },
      event.sender,
    );
  });
  handle("joty:run-cancel", ["main"], (_event, runId) => {
    runs.get(runId)?.cancel();
  });

  // Sealed sheets.
  handle("joty:sealed-read", ["main"], () => sealedStore.read());
  handle("joty:sealed-write", ["main"], (_event, payload) => sealedStore.write(payload));

  // Screen clip and OCR.
  handle("joty:screen-clip", [], async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    clipping = true;
    let result;
    try {
      result = await screenClip({ windows: [mainWindow, captureWindow], focusAfter: sender, log });
    } finally {
      clipping = false;
    }
    if (!result) return null;
    const text = await ocrPng(result.png).catch(() => "");
    return { png: result.png, text: text || null };
  });
  handle("joty:ocr", [], (_event, png) => {
    if (!(png instanceof Uint8Array) || png.length > 64 * 1024 * 1024)
      throw new Error("Invalid image.");
    return ocrPng(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
  });

  // Quick capture window.
  handle("joty:capture-done", ["capture"], () => hideCapture());
  handle("joty:capture-show", ["main"], () => showCapture());
  handle("joty:is-quick-capture", [], (event) => senderKind(event) === "capture");
  handle("joty:close-quick-capture", ["capture"], () => hideCapture());

  // Export the current page as PDF.
  handle("joty:print-note-pdf", ["main"], async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    try {
      const data = await mainWindow.webContents.printToPDF({ printBackground: true });
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: "Export as PDF",
        defaultPath: "sheet.pdf",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (canceled || !filePath) return { ok: false };
      await fs.promises.writeFile(filePath, data);
      return { ok: true, filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

// --- App lifecycle + single-instance ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, workingDirectory) => {
    // A deep link launched the second instance (Windows passes it in argv).
    const deepLink = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (deepLink) handleDeepLink(deepLink);
    else focusMainWindow();
    void openFileArguments(argv, workingDirectory);
  });

  // macOS delivers deep links via open-url.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    requestOpenFiles([filePath]);
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
    sealedStore = createSealedStore({
      file: path.join(app.getPath("userData"), "joty-sealed.bin"),
      safeStorage,
    });

    if (isDev && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }

    if (!isDev) registerAppProtocol(path.join(app.getAppPath(), "dist", "renderer"));
    auth = createAuthManager();
    // No application menu: the web app owns its shortcuts (see handleShellKeys).
    Menu.setApplicationMenu(null);
    registerIpc();
    createTray();

    return createWindow().then(() => {
      applySettings();
      registerCaptureHotkey(settings.quickCaptureShortcut);
      if (captureHotkey.error) log.warn(`[capture] ${captureHotkey.error}`);
      // Pre-warm the capture slip so the hotkey shows it at once.
      createCaptureWindow();
      void openFileArguments(process.argv, process.cwd());
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
    for (const run of runs.values()) run.cancel();
    for (const entry of followers.values()) entry.follower.close();
  });

  app.on("window-all-closed", () => {
    // With minimize-to-tray the main window can be hidden, not closed; only
    // quit when the user really asked to (tray → Quit, or non-tray platforms).
    if (isQuitting || !settings.minimizeToTray) {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else focusMainWindow();
  });
}
