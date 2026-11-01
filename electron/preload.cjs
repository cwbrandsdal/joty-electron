const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Shared by the main window and the capture slip. Only Joty's own pages get
// the bridge (the main window also shows the hosted sign-in page); the main
// process checks every request's sender again.
const TRUSTED_ORIGINS = new Set(["app://joty", "http://127.0.0.1:39173"]);

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** invoke() with the "Error invoking remote method" noise removed. */
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    const message = String(error?.message ?? error).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      "",
    );
    throw new Error(message);
  });
}

const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const api = {
  version: arg("joty-version") ?? "",
  /** "main" or "capture". */
  window: arg("joty-window") ?? "main",

  // --- File sheets ---
  files: {
    pick: () => invoke("joty:files-pick"),
    open: (path) => invoke("joty:files-open", path),
    write: (path, text, opts) => invoke("joty:files-write", path, text, opts),
    /** Follow a file; returns an unsubscribe function. */
    watch: (path, callback) => {
      const watchId = newId();
      const listener = (_event, message) => {
        if (message?.watchId === watchId) callback(message.event);
      };
      ipcRenderer.on("joty:files-watch-event", listener);
      invoke("joty:files-watch", watchId, path).catch(() => {});
      return () => {
        ipcRenderer.removeListener("joty:files-watch-event", listener);
        invoke("joty:files-unwatch", watchId).catch(() => {});
      };
    },
    recent: () => invoke("joty:files-recent"),
    reveal: (path) => void invoke("joty:files-reveal", path).catch(() => {}),
    /** Paths to open from the command line, Open with, a second instance or a drop. */
    onOpenRequest: (callback) => {
      const off = subscribe("joty:files-open-request", callback);
      invoke("joty:files-take-open-requests")
        .then((queued) => {
          if (queued?.length) callback(queued);
        })
        .catch(() => {});
      return off;
    },
    /** The disk path of a dropped File (empty when it has none). */
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return "";
      }
    },
    /** Open dropped paths that are text files as file sheets; returns those accepted. */
    openDropped: (paths) => invoke("joty:files-dropped", paths),
  },

  // --- Run blocks ---
  run: {
    available: () => invoke("joty:run-available"),
    /** Start a run; events arrive in order; returns cancel(). */
    start: (req, callback) => {
      const runId = newId();
      let done = false;
      const listener = (_event, message) => {
        if (message?.runId !== runId) return;
        for (const event of message.events) {
          if (done) break;
          callback(event);
          if (event.type === "exit") {
            done = true;
            ipcRenderer.removeListener("joty:run-events", listener);
          }
        }
      };
      ipcRenderer.on("joty:run-events", listener);
      invoke("joty:run-start", runId, req).catch((error) => {
        if (done) return;
        done = true;
        ipcRenderer.removeListener("joty:run-events", listener);
        callback({ type: "error", message: error.message });
        callback({ type: "exit", code: -1, ms: 0 });
      });
      return () => {
        if (!done) invoke("joty:run-cancel", runId).catch(() => {});
      };
    },
  },

  // --- Sealed sheets (OS key store) ---
  sealed: {
    read: () => invoke("joty:sealed-read"),
    write: (payload) => invoke("joty:sealed-write", payload),
  },

  // --- Frameless window chrome ---
  windowChrome: {
    /** Width of the native caption buttons in DIPs (the fallback when WCO is absent). */
    controlsWidth: Number(arg("joty-controls-width")) || 0,
    setColors: (colors) => invoke("joty:window-set-colors", colors),
    setMaterial: (material) => invoke("joty:window-set-material", material),
  },

  // --- Screen clip and OCR ---
  screenClip: () => invoke("joty:screen-clip"),
  ocr: (png) => invoke("joty:ocr", png),

  // --- Desktop preferences ---
  prefs: {
    get: () => invoke("joty:prefs-get"),
    set: (patch) => invoke("joty:prefs-set", patch),
  },

  // --- Capture slip ---
  capture: {
    /** The slip has jotted (or was dismissed): hide it. */
    done: () => invoke("joty:capture-done"),
    close: () => invoke("joty:capture-done"),
    /** Show the slip (from the main window). */
    show: () => invoke("joty:capture-show"),
    /** The slip is being shown: reset and focus the input. */
    onShow: (callback) => subscribe("joty:capture-show", callback),
    onHide: (callback) => subscribe("joty:capture-hide", callback),
  },

  openExternal: (url) => invoke("joty:open-external", url),

  // --- Authentication (owned by the main process; see electron/auth.cjs) ---
  auth: {
    getState: () => invoke("joty:auth-get-state"),
    getAccessToken: () => invoke("joty:auth-get-access-token"),
    signIn: (returnTo) => invoke("joty:auth-sign-in", returnTo),
    signOut: () => invoke("joty:auth-sign-out"),
    onState: (callback) => subscribe("joty:auth-state", callback),
  },

  // --- Diagnostics ---
  /** Append a line to the main-process log file (no secrets, no note text). */
  log: (level, message) => invoke("joty:log", level, message),
  /** Build a diagnostics report, copy it to the clipboard, and return its size. */
  copyDiagnostics: () => invoke("joty:copy-diagnostics"),

  // --- Auto-update ---
  getAppUpdateState: () => invoke("joty:get-app-update-state"),
  checkForAppUpdates: () => invoke("joty:check-for-app-updates"),
  downloadAppUpdate: () => invoke("joty:download-app-update"),
  installAppUpdate: () => invoke("joty:install-app-update"),
  onAppUpdateState: (callback) => subscribe("joty:app-update-state", callback),

  // --- Tray / deep-link actions forwarded to the renderer ---
  onMenuAction: (callback) => subscribe("joty:menu-action", callback),
  /** Deep link: main asks the renderer to open a specific note id. */
  onOpenNote: (callback) => subscribe("joty:open-note", callback),

  // --- Older settings shape (kept for older renderers) ---
  getSettings: () => invoke("joty:get-settings"),
  updateSettings: (partial) => invoke("joty:update-settings", partial),

  // --- Export / print ---
  printNoteToPdf: () => invoke("joty:print-note-pdf"),

  // --- Older quick-capture contract ---
  isQuickCapture: () => invoke("joty:is-quick-capture"),
  closeQuickCapture: () => invoke("joty:close-quick-capture"),
};

if (TRUSTED_ORIGINS.has(window.location.origin)) {
  contextBridge.exposeInMainWorld("joty", api);
  // Also a DOM event, for pages that listen without the bridge's types.
  ipcRenderer.on("joty:capture-show", () => window.dispatchEvent(new Event("joty:capture-show")));
}
