// Isolated main-process fixture for scripts/smoke-desktop.mjs: the real
// shell, preload and built renderer with a throwaway profile and a fake
// account. Nothing is registered with Windows (login item, joty://).
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const profile = process.env.JOTY_SMOKE_PROFILE;
if (!profile) throw new Error("An isolated smoke profile is required");
fs.mkdirSync(profile, { recursive: true });
app.setName("Joty Smoke Test");
app.setAppPath(root);
app.setPath("userData", profile);
const settingsFile = path.join(profile, "joty-settings.json");
if (!fs.existsSync(settingsFile)) {
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      launchAtLogin: false,
      minimizeToTray: false,
      autoDownloadUpdates: false,
      quickCaptureShortcut: "CommandOrControl+Shift+J",
      zoomFactor: 1,
    }),
  );
}
// Started as `electron fixture.cjs`, Electron would report its own version.
const { version } = require(path.join(root, "package.json"));
app.getVersion = () => version;
app.setAsDefaultProtocolClient = () => false;
app.setLoginItemSettings = () => {};
const signedIn = process.env.JOTY_SMOKE_SIGNED_IN === "1";
require(path.join(root, "electron/auth.cjs")).AuthManager = class {
  initialize() {}
  onResume() {}
  cancelPendingSignIn() {}
  getState() {
    return {
      status: signedIn ? "signed-in" : "signed-out",
      user: signedIn ? { id: "smoke-user", email: "smoke@example.com" } : null,
      error: null,
    };
  }
  async getAccessToken() {
    return { token: signedIn ? "smoke-token" : null };
  }
};
// JOTY_SMOKE_CLIPBOARD=mock: main-process clipboard calls go to memory, never
// to the system clipboard (anything but text and buffers throws). The smoke
// test then skips the secret-clipboard check: its private copy goes through
// Chromium, which this cannot intercept.
if (process.env.JOTY_SMOKE_CLIPBOARD === "mock") {
  const { clipboard } = require("electron");
  const held = new Map();
  const replace = (format, value) => {
    held.clear();
    held.set(format, value);
  };
  const mock = {
    readText: () => held.get("text/plain") ?? "",
    writeText: (text) => replace("text/plain", String(text)),
    clear: () => held.clear(),
    availableFormats: () => [...held.keys()],
    has: (format) => held.has(format),
    readBuffer: (format) => held.get(format) ?? Buffer.alloc(0),
    writeBuffer: (format, buffer) => replace(format, Buffer.from(buffer)),
  };
  const names = new Set([
    ...Object.keys(clipboard),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(clipboard) ?? {}),
  ]);
  for (const name of names) {
    if (name === "constructor" || typeof clipboard[name] !== "function") continue;
    const fn =
      mock[name] ??
      (() => {
        throw new Error(`clipboard.${name} is not available in a mocked smoke run`);
      });
    clipboard[name] = fn;
    if (clipboard[name] !== fn) throw new Error(`Could not mock clipboard.${name}`);
  }
  for (const name of Object.keys(mock)) {
    if (clipboard[name] !== mock[name]) throw new Error(`Could not mock clipboard.${name}`);
  }
}
process.env.JOTY_USE_BUILT_RENDERER = "1";
require(path.join(root, "electron/main.cjs"));
