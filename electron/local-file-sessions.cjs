const { dialog, ipcMain } = require("electron");
const { randomUUID } = require("node:crypto");
const { readDocument, saveDocument } = require("./local-files.cjs");

// Main-process file capabilities are opaque IDs, never renderer-supplied paths.
function createLocalFileSessions({ getWindow, isTrusted, focusMain }) {
  const documents = new Map();
  let openedId = null;
  let openSequence = 0;
  const pathKey = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const snapshot = (doc) => ({
    id: doc.id,
    path: doc.path,
    name: doc.name,
    body: doc.body,
    savedBody: doc.savedBody,
    error: doc.error ?? null,
  });
  const list = () => ({
    ready: true,
    openedId,
    openSequence,
    files: [...documents.values()].map((doc) => ({
      id: doc.id,
      path: doc.path,
      name: doc.name,
      dirty: doc.body !== doc.savedBody,
    })),
  });
  function send(channel, value) {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send(channel, value);
  }
  const publishList = () => send("joty:files-changed", list());
  function publish(doc) {
    send("joty:file-state", snapshot(doc));
    publishList();
  }
  function trusted(event) {
    const win = getWindow();
    if (
      !win ||
      event.sender !== win.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !isTrusted(event.senderFrame.url)
    )
      throw new Error("Untrusted file request.");
  }
  function fromEvent(event, id) {
    trusted(event);
    const doc = documents.get(id);
    if (!doc) throw new Error("This local file is no longer open.");
    return doc;
  }
  function save(doc) {
    try {
      saveDocument(doc);
      doc.error = null;
      publish(doc);
      return { ok: true };
    } catch (error) {
      doc.error = error.message;
      publish(doc);
      return { ok: false, error: error.message };
    }
  }
  function confirm(doc) {
    if (doc.body === doc.savedBody) return true;
    focusMain();
    const answer = dialog.showMessageBoxSync(getWindow(), {
      type: "warning",
      title: "Unsaved file changes",
      message: `Save changes to ${doc.name}?`,
      detail: doc.path,
      buttons: ["Save", "Discard", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return answer === 1 || (answer === 0 && save(doc).ok);
  }
  function open(filePath) {
    try {
      const incoming = readDocument(filePath);
      let doc = [...documents.values()].find((d) => pathKey(d.path) === pathKey(incoming.path));
      if (!doc) {
        doc = { ...incoming, id: `local:${randomUUID()}`, approvedCloseBody: null };
        documents.set(doc.id, doc);
      }
      openedId = doc.id;
      openSequence++;
      focusMain();
      publishList();
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
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (!result.canceled) result.filePaths.forEach(open);
  }
  ipcMain.handle("joty:files-open", (event) => {
    trusted(event);
    return pick();
  });
  ipcMain.handle("joty:files-list", (event) => {
    trusted(event);
    return list();
  });
  ipcMain.handle("joty:file-get", (event, id) => snapshot(fromEvent(event, id)));
  ipcMain.on("joty:file-draft", (event, id, body) => {
    try {
      const doc = fromEvent(event, id);
      if (typeof body !== "string") return;
      const wasDirty = doc.body !== doc.savedBody;
      doc.body = body;
      if (wasDirty !== (doc.body !== doc.savedBody)) publishList();
    } catch {
      /* Ignore stale/untrusted draft messages. */
    }
  });
  ipcMain.handle("joty:file-save", (event, id) => save(fromEvent(event, id)));
  ipcMain.handle("joty:files-close", (event, ids) => {
    trusted(event);
    if (!Array.isArray(ids)) throw new Error("Invalid file selection.");
    const selected = [...new Set(ids)].map((id) => fromEvent(event, id));
    // Cancel retains every tab in a bulk close. Earlier Save choices stay saved.
    if (!selected.every(confirm)) return false;
    selected.forEach((doc) => documents.delete(doc.id));
    if (!documents.has(openedId)) openedId = null;
    publishList();
    return true;
  });
  ipcMain.handle("joty:file-reload", (event, id) => {
    const doc = fromEvent(event, id);
    if (
      doc.body !== doc.savedBody &&
      dialog.showMessageBoxSync(getWindow(), {
        type: "warning",
        message: "Discard your edits and reload from disk?",
        buttons: ["Cancel", "Reload"],
        defaultId: 0,
        cancelId: 0,
      }) !== 1
    )
      return null;
    try {
      Object.assign(doc, readDocument(doc.path), { error: null });
      publish(doc);
      return snapshot(doc);
    } catch (error) {
      doc.error = error.message;
      publish(doc);
      return null;
    }
  });
  return {
    open,
    pick,
    confirmQuit() {
      if (![...documents.values()].every(confirm)) return false;
      for (const doc of documents.values()) doc.approvedCloseBody = doc.body;
      return true;
    },
    confirmUnload() {
      if (
        ![...documents.values()].every((doc) => doc.approvedCloseBody === doc.body || confirm(doc))
      )
        return false;
      for (const doc of documents.values()) {
        doc.body = doc.savedBody;
        doc.approvedCloseBody = null;
      }
      publishList();
      return true;
    },
  };
}
module.exports = { createLocalFileSessions };
