import type { Platform, UpdateStatus } from "@/platform/platform";
import type { AppUpdateState, JotyApi } from "./electron-api";
import { createWindowChrome } from "./window-chrome";

/** electron-updater's phases in the shape the app shows. `progress` is 0–100. */
export function toUpdateStatus(state: AppUpdateState): UpdateStatus {
  const version = state.availableVersion ?? null;
  switch (state.phase) {
    case "checking":
      return { state: "checking" };
    case "available":
      return { state: "available", version };
    case "downloading":
      return { state: "downloading", version, progress: state.percent ?? null };
    case "downloaded":
      return { state: "ready", version, progress: 100 };
    case "not-available":
      return { state: "none" };
    case "error":
      return { state: "error", message: state.error ?? "The update failed." };
    case "unsupported":
      return { state: "idle", message: "Updates come with the installed app." };
    default:
      return { state: "idle" };
  }
}

function updates(bridge: JotyApi): NonNullable<Platform["updates"]> {
  return {
    get: () => bridge.getAppUpdateState().then(toUpdateStatus),
    subscribe: (listener) => bridge.onAppUpdateState((state) => listener(toUpdateStatus(state))),
    check: async () => {
      await bridge.checkForAppUpdates();
    },
    // Without automatic downloads an available update is fetched first.
    install: async () => {
      let state = await bridge.getAppUpdateState();
      if (state.phase === "available") state = await bridge.downloadAppUpdate();
      if (state.phase === "downloaded") await bridge.installAppUpdate();
    },
  };
}

/**
 * Platform["clipboard"] in joty-web (added with the secrets work). Declared
 * here too so this shell type-checks against a web tree with or without it.
 */
interface SecretClipboard {
  /** Copy a secret; the clipboard is cleared after `clearAfterMs` if it still holds it. */
  writeSecret(text: string, clearAfterMs: number): Promise<void>;
}

type DesktopPlatform = Platform & { clipboard?: SecretClipboard };

/**
 * The desktop Platform. The main window gets everything; the capture slip
 * only what a slip needs (the main process refuses the rest from it anyway).
 */
function createDesktopPlatform(): DesktopPlatform {
  const bridge = window.joty;
  if (!bridge) return { name: "desktop" };

  const shared: Platform = {
    name: "desktop",
    version: bridge.version,
    screenClip: () => bridge.screenClip(),
    ocr: (png) => bridge.ocr(png),
    desktopPrefs: {
      get: () => bridge.prefs.get(),
      set: (patch) => bridge.prefs.set(patch),
    },
    openExternal: (url) => void bridge.openExternal(url).catch(() => {}),
    copyDiagnostics: async () => {
      await bridge.copyDiagnostics();
    },
  };
  if (bridge.window === "capture") return shared;

  return {
    ...shared,
    files: {
      pick: () => bridge.files.pick(),
      open: (path) => bridge.files.open(path),
      write: (path, text, opts) => bridge.files.write(path, text, opts),
      watch: (path, onEvent) => bridge.files.watch(path, onEvent),
      recent: () => bridge.files.recent(),
      onOpenRequest: (handler) => bridge.files.onOpenRequest(handler),
      reveal: (path) => bridge.files.reveal(path),
    },
    run: {
      available: () => bridge.run.available(),
      run: (req, onEvent) => bridge.run.start(req, onEvent),
    },
    sealed: {
      read: () => bridge.sealed.read(),
      write: (payload) => bridge.sealed.write(payload),
    },
    clipboard: {
      writeSecret: async (text: string, clearAfterMs: number) => {
        await bridge.clipboard.writeSecret(text, clearAfterMs);
      },
    },
    windowChrome: createWindowChrome(bridge),
    updates: updates(bridge),
    onMenuAction: (handler) => bridge.onMenuAction(handler),
    onOpenNote: (handler) => bridge.onOpenNote(handler),
    printNoteToPdf: () => void bridge.printNoteToPdf(),
  };
}

export const desktopPlatform: DesktopPlatform = createDesktopPlatform();
