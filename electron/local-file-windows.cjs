const { BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const { readDocument, saveDocument } = require("./local-files.cjs");

function createLocalFileWindows({ baseUrl, isTrusted, focusMain, openNote, attachContextMenu }) {
  const documents = new Map();
  const key = (filePath) => (process.platform === "win32" ? filePath.toLowerCase() : filePath);
  const snapshot = (doc) => ({
    path: doc.path,
    name: doc.name,
    body: doc.body,
    savedBody: doc.savedBody,
  });
  const title = (entry) => {
    if (!entry.win.isDestroyed())
      entry.win.setTitle(
        `${entry.doc.body !== entry.doc.savedBody ? "* " : ""}${entry.doc.name} — Local file — Joty`,
      );
  };
  const publish = (entry) => {
    title(entry);
    entry.win.webContents.send("joty:file-state", snapshot(entry.doc));
  };
  function trusted(event) {
    if (event.senderFrame !== event.sender.mainFrame || !isTrusted(event.senderFrame.url))
      throw new Error("Untrusted file request.");
  }
  function fromEvent(event) {
    trusted(event);
    const entry = [...documents.values()].find((item) => item.win.webContents === event.sender);
    if (!entry) throw new Error("This window does not own a local file.");
    return entry;
  }
  function save(entry) {
    try {
      saveDocument(entry.doc);
      publish(entry);
      return { ok: true };
    } catch (error) {
      entry.win.webContents.send("joty:file-error", error.message);
      return { ok: false, error: error.message };
    }
  }
  function confirmDiscard(entry) {
    if (entry.doc.body === entry.doc.savedBody) return true;
    entry.win.show();
    const answer = dialog.showMessageBoxSync(entry.win, {
      type: "warning",
      title: "Unsaved file changes",
      message: `Save changes to ${entry.doc.name}?`,
      detail: entry.doc.path,
      buttons: ["Save", "Discard", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return answer === 1 || (answer === 0 && save(entry).ok);
  }
  function open(filePath) {
    try {
      const doc = readDocument(filePath);
      const existing = documents.get(key(doc.path));
      if (existing) {
        if (existing.win.isMinimized()) existing.win.restore();
        existing.win.show();
        existing.win.focus();
        return;
      }
      const win = new BrowserWindow({
        width: 1100,
        height: 800,
        minWidth: 620,
        minHeight: 400,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          spellcheck: true,
          preload: path.join(__dirname, "preload.cjs"),
        },
      });
      const entry = { win, doc, approvedCloseBody: null };
      documents.set(key(doc.path), entry);
      title(entry);
      win.on("page-title-updated", (event) => event.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      attachContextMenu(win.webContents);
      // Also protects renderer reloads, including changes sent immediately before unload.
      win.webContents.on("will-prevent-unload", (event) => {
        if (entry.approvedCloseBody === entry.doc.body || confirmDiscard(entry)) {
          entry.doc.body = entry.doc.savedBody;
          event.preventDefault();
        }
      });
      win.on("closed", () => documents.delete(key(doc.path)));
      // Showing after load also works when an occluded Electron window never
      // emits ready-to-show (its first frame can otherwise remain suspended).
      void win.loadURL(`${baseUrl()}/?localFile=1`).then(() => {
        if (!win.isDestroyed()) {
          win.show();
          win.focus();
        }
      });
    } catch (error) {
      dialog.showErrorBox("Couldn't open file", `${filePath}\n\n${error.message}`);
    }
  }
  async function pick() {
    const options = {
      title: "Open a file from your computer",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Text and Markdown", extensions: ["txt", "md", "markdown", "log"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const parent = BrowserWindow.getFocusedWindow();
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (!result.canceled) result.filePaths.forEach(open);
  }
  ipcMain.handle("joty:files-open", (event) => {
    trusted(event);
    return pick();
  });
  ipcMain.handle("joty:file-get", (event) => snapshot(fromEvent(event).doc));
  ipcMain.on("joty:file-draft", (event, body) => {
    try {
      const entry = fromEvent(event);
      if (typeof body !== "string") return;
      entry.doc.body = body;
      title(entry);
    } catch {
      /* Ignore messages from windows without a disk document. */
    }
  });
  ipcMain.handle("joty:file-save", (event) => save(fromEvent(event)));
  ipcMain.handle("joty:file-reload", (event) => {
    const entry = fromEvent(event);
    if (
      entry.doc.body !== entry.doc.savedBody &&
      dialog.showMessageBoxSync(entry.win, {
        type: "warning",
        message: "Discard your edits and reload from disk?",
        buttons: ["Cancel", "Reload"],
        defaultId: 0,
        cancelId: 0,
      }) !== 1
    )
      return null;
    try {
      entry.doc = readDocument(entry.doc.path);
      publish(entry);
      return snapshot(entry.doc);
    } catch (error) {
      entry.win.webContents.send("joty:file-error", error.message);
      return null;
    }
  });
  ipcMain.handle("joty:file-open-note", (event, id) => {
    fromEvent(event);
    if (typeof id !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
      throw new Error("Invalid note ID.");
    openNote(id);
  });
  ipcMain.handle("joty:file-show-joty", (event) => {
    fromEvent(event);
    focusMain();
  });
  return {
    open,
    pick,
    saveFocused() {
      const entry = [...documents.values()].find(
        (item) => item.win === BrowserWindow.getFocusedWindow(),
      );
      // Let the renderer enqueue save after its latest synchronous onChange IPC.
      // A native accelerator can otherwise overtake an in-flight draft message.
      if (entry) entry.win.webContents.send("joty:file-save-request");
    },
    closeFocused() {
      const entry = [...documents.values()].find(
        (item) => item.win === BrowserWindow.getFocusedWindow(),
      );
      if (!entry) return false;
      entry.win.close();
      return true;
    },
    confirmQuit() {
      // Do not grant any close permissions until all windows approve quitting.
      for (const entry of documents.values()) if (!confirmDiscard(entry)) return false;
      for (const entry of documents.values()) entry.approvedCloseBody = entry.doc.body;
      return true;
    },
  };
}
module.exports = { createLocalFileWindows };
