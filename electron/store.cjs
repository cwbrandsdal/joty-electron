const { app } = require("electron");
const path = require("path");
const fs = require("fs");

// Tiny JSON-file store in userData for desktop settings and window state.
// Deliberately dependency-free and synchronous — the payloads are tiny and
// only read/written at startup, on settings changes, and on window close.

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "joty-settings.json");
const WINDOW_FILE = () => path.join(app.getPath("userData"), "joty-window.json");

const DEFAULT_SETTINGS = {
  launchAtLogin: false,
  minimizeToTray: false,
  autoDownloadUpdates: false,
  quickCaptureShortcut: "CommandOrControl+Shift+J",
  zoomFactor: 1,
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
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
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

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  loadWindowState,
  saveWindowState,
};
