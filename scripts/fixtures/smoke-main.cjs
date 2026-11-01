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
process.env.JOTY_USE_BUILT_RENDERER = "1";
require(path.join(root, "electron/main.cjs"));
