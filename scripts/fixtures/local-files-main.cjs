// Isolated main-process fixture: real shell, preload and built renderer, fake account.
const { app, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const profile = process.env.JOTY_SMOKE_PROFILE;
if (!profile) throw new Error("An isolated smoke profile is required");
fs.mkdirSync(profile, { recursive: true });
app.setName("Joty Local File Test");
app.setAppPath(root);
app.setPath("userData", profile);
fs.writeFileSync(
  path.join(profile, "joty-settings.json"),
  JSON.stringify({
    launchAtLogin: false,
    minimizeToTray: false,
    autoDownloadUpdates: false,
    quickCaptureShortcut: "",
    zoomFactor: 1,
  }),
);
app.setAsDefaultProtocolClient = () => false;
app.setLoginItemSettings = () => {};
globalThis.testSignedIn = false;
globalThis.testDialogs = [];
globalThis.testDialogAnswer = 2;
dialog.showMessageBoxSync = (_parent, options) => {
  globalThis.testDialogs.push(options.message);
  return globalThis.testDialogAnswer;
};
dialog.showErrorBox = (title, message) => {
  throw new Error(`${title}: ${message}`);
};
require(path.join(root, "electron/auth.cjs")).AuthManager = class {
  initialize() {}
  onResume() {}
  cancelPendingSignIn() {}
  getState() {
    return {
      status: globalThis.testSignedIn ? "signed-in" : "signed-out",
      user: globalThis.testSignedIn ? { id: "file-test-user", email: "test@example.com" } : null,
      error: null,
    };
  }
  async getAccessToken() {
    return { token: "local-test-token" };
  }
};
process.env.JOTY_USE_BUILT_RENDERER = "1";
require(path.join(root, "electron/main.cjs"));
