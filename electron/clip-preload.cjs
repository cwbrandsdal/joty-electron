// Preload for the screen-clip overlay: receives the frozen screen image and
// returns the chosen rectangle (or null). Nothing else is exposed.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clip", {
  onImage: (callback) => ipcRenderer.once("joty:clip-image", (_event, image) => callback(image)),
  ready: () => ipcRenderer.send("joty:clip-ready"),
  finish: (rect) => ipcRenderer.send("joty:clip-result", rect ?? null),
});
