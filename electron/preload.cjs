const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("joty", {
  getAppUpdateState: () => ipcRenderer.invoke("joty:get-app-update-state"),
  checkForAppUpdates: () => ipcRenderer.invoke("joty:check-for-app-updates"),
  downloadAppUpdate: () => ipcRenderer.invoke("joty:download-app-update"),
  installAppUpdate: () => ipcRenderer.invoke("joty:install-app-update"),
  onAppUpdateState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("joty:app-update-state", listener);
    return () => ipcRenderer.removeListener("joty:app-update-state", listener);
  },
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("joty:menu-action", listener);
    return () => ipcRenderer.removeListener("joty:menu-action", listener);
  },
});
