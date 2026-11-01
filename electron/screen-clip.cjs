// Screen clip: freeze the display under the cursor, let the person drag a
// region on a full-screen overlay, crop it to PNG. Joty's own windows are
// hidden first so they are not in the picture. Pixels stay local.
const { BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen } = require("electron");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let active = null;

function validRect(rect, bounds) {
  if (!rect || typeof rect !== "object") return null;
  const values = ["x", "y", "width", "height"].map((k) => Number(rect[k]));
  if (!values.every(Number.isFinite)) return null;
  let [x, y, width, height] = values;
  x = Math.max(0, Math.min(x, bounds.width));
  y = Math.max(0, Math.min(y, bounds.height));
  width = Math.min(width, bounds.width - x);
  height = Math.min(height, bounds.height - y);
  return width >= 2 && height >= 2 ? { x, y, width, height } : null;
}

/** Crop a display-sized image by a rectangle in display DIPs. */
function cropToPng(image, display, rect) {
  const normalized = nativeImage.createFromBuffer(image.toPNG(), { scaleFactor: 1 });
  const actual = normalized.getSize();
  const sx = actual.width / display.bounds.width;
  const sy = actual.height / display.bounds.height;
  const left = Math.max(0, Math.floor(rect.x * sx));
  const top = Math.max(0, Math.floor(rect.y * sy));
  const right = Math.min(actual.width, Math.ceil((rect.x + rect.width) * sx));
  const bottom = Math.min(actual.height, Math.ceil((rect.y + rect.height) * sy));
  if (right <= left || bottom <= top) return null;
  return normalized.crop({ x: left, y: top, width: right - left, height: bottom - top }).toPNG();
}

async function grabDisplay(display) {
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale),
    },
    fetchWindowIcons: false,
  });
  const match =
    sources.find((s) => s.display_id === String(display.id)) ??
    (sources.length === 1 ? sources[0] : null);
  if (!match || match.thumbnail.isEmpty()) throw new Error("Could not capture this screen.");
  return match.thumbnail;
}

function selectRegion(display, image, log) {
  return new Promise((resolve) => {
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      show: false,
      title: "Joty screen clip",
      webPreferences: {
        preload: path.join(__dirname, "clip-preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    let settled = false;
    const done = (rect) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("joty:clip-ready", onReady);
      ipcMain.removeListener("joty:clip-result", onResult);
      if (!overlay.isDestroyed()) overlay.destroy();
      resolve(rect);
    };
    const fromOverlay = (event) => !overlay.isDestroyed() && event.sender === overlay.webContents;
    const onReady = (event) => {
      if (!fromOverlay(event)) return;
      // Windows can size a new window for the wrong monitor's DPI; pin it.
      overlay.setBounds(display.bounds);
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.show();
      overlay.focus();
    };
    const onResult = (event, rect) => {
      if (!fromOverlay(event)) return;
      done(rect ? validRect(rect, display.bounds) : null);
    };
    ipcMain.on("joty:clip-ready", onReady);
    ipcMain.on("joty:clip-result", onResult);
    overlay.on("closed", () => done(null));
    overlay.webContents.on("render-process-gone", () => done(null));
    overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay.webContents.on("will-navigate", (event) => event.preventDefault());
    overlay.webContents.once("did-finish-load", () => {
      overlay.webContents.setZoomFactor(1);
      overlay.webContents.send("joty:clip-image", {
        // JPEG keeps the IPC hop quick; the crop uses the lossless capture.
        src: `data:image/jpeg;base64,${image.toJPEG(92).toString("base64")}`,
        width: display.bounds.width,
        height: display.bounds.height,
      });
    });
    overlay.loadFile(path.join(__dirname, "clip-overlay.html")).catch((error) => {
      log?.warn(`[clip] overlay failed: ${error.message}`);
      done(null);
    });
  });
}

/**
 * Run a clip. `windows` are hidden during the capture and restored after;
 * `focusAfter` gets focus back. Resolves { png: Buffer } or null if cancelled.
 */
async function screenClip({ windows, focusAfter, log }) {
  if (active) throw new Error("A screen clip is already in progress.");
  active = (async () => {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const hidden = windows.filter((w) => w && !w.isDestroyed() && w.isVisible());
    hidden.forEach((w) => w.hide());
    try {
      // Give the compositor time to take Joty's windows off the screen.
      if (hidden.length) await sleep(220);
      const image = await grabDisplay(display);
      const rect = await selectRegion(display, image, log);
      if (!rect) return null;
      const png = cropToPng(image, display, rect);
      return png ? { png } : null;
    } finally {
      for (const w of hidden) {
        if (w.isDestroyed()) continue;
        if (w === focusAfter) w.show();
        else w.showInactive();
      }
      if (focusAfter && !focusAfter.isDestroyed()) focusAfter.focus();
    }
  })();
  try {
    return await active;
  } finally {
    active = null;
  }
}

module.exports = { screenClip, validRect };
