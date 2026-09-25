const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("joty", {
  // --- Authentication (owned by the main process; see electron/auth.cjs) ---
  auth: {
    getState: () => ipcRenderer.invoke("joty:auth-get-state"),
    getAccessToken: () => ipcRenderer.invoke("joty:auth-get-access-token"),
    signIn: (returnTo) => ipcRenderer.invoke("joty:auth-sign-in", returnTo),
    signOut: () => ipcRenderer.invoke("joty:auth-sign-out"),
    onState: (callback) => subscribe("joty:auth-state", callback),
  },

  // --- Auto-update ---
  getAppUpdateState: () => ipcRenderer.invoke("joty:get-app-update-state"),
  checkForAppUpdates: () => ipcRenderer.invoke("joty:check-for-app-updates"),
  downloadAppUpdate: () => ipcRenderer.invoke("joty:download-app-update"),
  installAppUpdate: () => ipcRenderer.invoke("joty:install-app-update"),
  onAppUpdateState: (callback) => subscribe("joty:app-update-state", callback),

  // --- Native menu / deep-link actions forwarded to the renderer ---
  onMenuAction: (callback) => subscribe("joty:menu-action", callback),
  /** Deep link: main asks the renderer to open a specific note id. */
  onOpenNote: (callback) => subscribe("joty:open-note", callback),

  // --- Desktop settings ---
  getSettings: () => ipcRenderer.invoke("joty:get-settings"),
  updateSettings: (partial) => ipcRenderer.invoke("joty:update-settings", partial),

  // --- Export / print ---
  printNoteToPdf: () => ipcRenderer.invoke("joty:print-note-pdf"),

  // --- Quick capture window ---
  /** True inside the frameless quick-capture window. */
  isQuickCapture: () => ipcRenderer.invoke("joty:is-quick-capture"),
  closeQuickCapture: () => ipcRenderer.invoke("joty:close-quick-capture"),
});
