// Copying a secret (platform.clipboard.writeSecret): the text goes on the
// clipboard without entering Windows clipboard history or the cloud
// clipboard, and is cleared after a delay if the clipboard still holds it.
//
// Electron cannot add Windows' privacy formats next to text itself:
// clipboard.writeBuffer() empties the clipboard first, so text and
// `CanIncludeInClipboardHistory` cannot be combined through its API.
// Chromium does it on its own for copies made in an off-the-record profile,
// and an Electron session without `persist:` is one. So the copy is made in a
// short-lived hidden page on such a session: Windows then gets
// CanIncludeInClipboardHistory = 0 and CanUploadToCloudClipboard = 0 with the
// text. (ExcludeClipboardContentFromMonitorProcessing, which third-party
// clipboard managers read, is only written for Chromium's own password
// manager and is not reachable.) When that copy fails, the text is written
// with clipboard.writeText() and is still cleared on time.
const crypto = require("node:crypto");

const MAX_SECRET_CHARS = 1024 * 1024;
const MIN_CLEAR_MS = 1000;
const MAX_CLEAR_MS = 10 * 60 * 1000;
const PRIVATE_COPY_TIMEOUT_MS = 3000;
/** In memory (no `persist:`), so Chromium treats it as off the record. */
const PRIVATE_PARTITION = "joty-secret-clipboard";

const normalize = (text) => text.replace(/\r\n?/g, "\n");
/** What we remember about the copied secret: a hash, never the text. */
const digest = (text) =>
  crypto.createHash("sha256").update(normalize(text), "utf8").digest("base64");

/** Runs in the hidden page: puts exactly `text` on the clipboard through a copy event. */
function copyScript(text) {
  return `(() => {
  const text = ${JSON.stringify(text)};
  let wrote = false;
  const onCopy = (event) => {
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    wrote = true;
  };
  document.addEventListener("copy", onCopy, { once: true });
  const ok = document.execCommand("copy");
  document.removeEventListener("copy", onCopy);
  return ok && wrote;
})()`;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * privateCopy(text) → true when a hidden page on an in-memory session copied
 * the text. The page lives only for the copy (about 60 ms).
 */
function createPrivateCopier({ BrowserWindow, timeoutMs = PRIVATE_COPY_TIMEOUT_MS }) {
  return async function privateCopy(text) {
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      webPreferences: {
        partition: PRIVATE_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: false,
      },
    });
    try {
      if (win.webContents.session.isPersistent()) return false;
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      await withTimeout(win.loadURL("about:blank"), timeoutMs, "The clipboard page");
      const copied = await withTimeout(
        win.webContents.executeJavaScript(copyScript(text), true),
        timeoutMs,
        "The private copy",
      );
      return copied === true;
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  };
}

/**
 * writeSecret(text, clearAfterMs) → { historyExcluded, clearAfterMs }.
 * `clipboard` is Electron's (or a test double with readText/writeText/clear);
 * `privateCopy` is optional. Calls run one at a time; a newer secret takes
 * over the pending clear (the older one is no longer on the clipboard).
 */
function createSecretClipboard({
  clipboard,
  privateCopy = null,
  log = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let pending = null; // { digest, timer }
  let queue = Promise.resolve();

  /** Clears the clipboard if it still holds exactly the pending secret. */
  function clearIfUnchanged() {
    if (!pending) return false;
    const expected = pending.digest;
    clearTimer(pending.timer);
    pending = null;
    let current = "";
    try {
      current = clipboard.readText();
    } catch {
      return false;
    }
    if (!current || digest(current) !== expected) return false;
    clipboard.clear();
    return true;
  }

  async function write(text, clearAfterMs) {
    if (typeof text !== "string" || !text) throw new Error("Nothing to copy.");
    if (text.length > MAX_SECRET_CHARS) throw new Error("That is too long to copy as a secret.");
    if (typeof clearAfterMs !== "number" || !Number.isFinite(clearAfterMs) || clearAfterMs <= 0) {
      throw new Error("clearAfterMs must be a positive number of milliseconds.");
    }
    const delay = Math.min(Math.max(Math.round(clearAfterMs), MIN_CLEAR_MS), MAX_CLEAR_MS);
    const expected = digest(text);

    let historyExcluded = false;
    if (privateCopy) {
      try {
        if ((await privateCopy(text)) === true) {
          // The page's write reaches the OS through the browser process; give
          // it a moment before falling back (a fallback adds a history entry).
          for (let attempt = 0; attempt < 4 && !historyExcluded; attempt++) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, 25));
            historyExcluded = digest(clipboard.readText()) === expected;
          }
        }
      } catch (error) {
        log?.warn(`[clipboard] private copy failed: ${error?.message ?? error}`);
      }
    }
    if (!historyExcluded) {
      clipboard.writeText(text);
      if (privateCopy) log?.warn("[clipboard] secret copied without clipboard-history exclusion");
    }

    if (pending) clearTimer(pending.timer);
    pending = { digest: expected, timer: setTimer(clearIfUnchanged, delay) };
    return { historyExcluded, clearAfterMs: delay };
  }

  return {
    writeSecret(text, clearAfterMs) {
      const run = queue.then(() => write(text, clearAfterMs));
      queue = run.catch(() => {});
      return run;
    },
    /** At quit: clear now rather than leave the secret behind. */
    flush: () => clearIfUnchanged(),
    /** True while a clear is scheduled. */
    get pending() {
      return pending !== null;
    },
  };
}

module.exports = {
  MAX_CLEAR_MS,
  MIN_CLEAR_MS,
  PRIVATE_PARTITION,
  copyScript,
  createPrivateCopier,
  createSecretClipboard,
};
