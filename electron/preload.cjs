const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("joty", {
  // --- Auto-update ---
  getAppUpdateState: () => ipcRenderer.invoke("joty:get-app-update-state"),
  checkForAppUpdates: () => ipcRenderer.invoke("joty:check-for-app-updates"),
  downloadAppUpdate: () => ipcRenderer.invoke("joty:download-app-update"),
  installAppUpdate: () => ipcRenderer.invoke("joty:install-app-update"),
  onAppUpdateState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("joty:app-update-state", listener);
    return () => ipcRenderer.removeListener("joty:app-update-state", listener);
  },

  // --- Native menu / deep-link actions forwarded to the renderer ---
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("joty:menu-action", listener);
    return () => ipcRenderer.removeListener("joty:menu-action", listener);
  },
  /** Deep link: main asks the renderer to open a specific note id. */
  onOpenNote: (callback) => {
    const listener = (_event, noteId) => callback(noteId);
    ipcRenderer.on("joty:open-note", listener);
    return () => ipcRenderer.removeListener("joty:open-note", listener);
  },

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
