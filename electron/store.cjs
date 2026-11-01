const { app } = require("electron");
const path = require("path");
const fs = require("fs");

// Tiny JSON-file store in userData for desktop settings, window state and
// recent files. Deliberately dependency-free and synchronous — the payloads
// are tiny and only written on changes and on window close.

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "joty-settings.json");
const WINDOW_FILE = () => path.join(app.getPath("userData"), "joty-window.json");
const RECENT_FILE = () => path.join(app.getPath("userData"), "joty-recent.json");
const RECENT_LIMIT = 20;

// Defaults suit a notes app that is meant to stay open for weeks: closing the
// window keeps Joty in the tray, it comes back at login, and updates download
// on their own. `windowChrome` remembers the last skin's title bar colours so
// the next launch paints the right colours before the renderer loads.
const DEFAULT_SETTINGS = {
  launchAtLogin: true,
  minimizeToTray: true,
  autoDownloadUpdates: true,
  quickCaptureShortcut: "CommandOrControl+Shift+J",
  zoomFactor: 1,
  windowChrome: { color: "#e2e8d6", symbolColor: "#1d261e", material: "none" },
};

function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { ...fallback };
  }
}

function writeJson(file, value) {
  try {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
  } catch {
    // Non-fatal: a failed settings write just means it isn't remembered.
  }
}

function loadSettings() {
  return readJson(SETTINGS_FILE(), DEFAULT_SETTINGS);
}

function saveSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  writeJson(SETTINGS_FILE(), merged);
  return merged;
}

/** { x, y, width, height, maximized } or null when never saved. */
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_FILE(), "utf8"));
  } catch {
    return null;
  }
}

function saveWindowState(state) {
  writeJson(WINDOW_FILE(), state);
}

/** Recently opened or written file paths, newest first. */
function loadRecentFiles() {
  try {
    const list = JSON.parse(fs.readFileSync(RECENT_FILE(), "utf8"));
    return Array.isArray(list)
      ? list.filter((p) => typeof p === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function addRecentFile(filePath) {
  const key = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const list = [filePath, ...loadRecentFiles().filter((p) => key(p) !== key(filePath))].slice(
    0,
    RECENT_LIMIT,
  );
  fs.writeFileSync(RECENT_FILE(), JSON.stringify(list, null, 2), "utf8");
  return list;
}

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  loadWindowState,
  saveWindowState,
  loadRecentFiles,
  addRecentFile,
};
