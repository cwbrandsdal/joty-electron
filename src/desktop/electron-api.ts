import type {
  DesktopPrefs,
  FileOpenResult,
  FileWatchEvent,
  MenuAction,
  RunEvent,
  RunLanguage,
} from "@/platform/platform";

// The window.joty bridge exposed by electron/preload.cjs. Every call is
// validated again in the main process.

export type AppUpdatePhase =
  | "idle"
  | "unsupported"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  downloadedFile?: string;
  checkedAt?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
}

export interface DesktopAuthUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
}

export interface DesktopAuthState {
  status: "signed-in" | "signed-out";
  user: DesktopAuthUser | null;
  /** Why the last sign-in failed or the session ended; null when fine. */
  error: string | null;
}

export interface DesktopAccessToken {
  /** Null when signed out or (with `transient`) temporarily unavailable. */
  token: string | null;
  /** The session is intact but WorkOS could not be reached to refresh. */
  transient?: boolean;
}

export interface DesktopAuthApi {
  getState: () => Promise<DesktopAuthState>;
  getAccessToken: () => Promise<DesktopAccessToken>;
  signIn: (returnTo?: string) => Promise<void>;
  signOut: () => Promise<void>;
  onState: (callback: (state: DesktopAuthState) => void) => () => void;
}

export interface DiagnosticsResult {
  ok: boolean;
  length: number;
  file: string | null;
}

export interface SecretCopyResult {
  /** Windows got CanIncludeInClipboardHistory = 0 and CanUploadToCloudClipboard = 0. */
  historyExcluded: boolean;
  /** The delay actually used (clamped to 1 s – 10 min). */
  clearAfterMs: number;
}

export interface DesktopPrefsState extends DesktopPrefs {
  /** Why the capture hotkey is not registered (taken by another app), or null. */
  captureHotkeyError: string | null;
}

export interface JotyApi {
  version: string;
  /** Which window this page is in. */
  window: "main" | "capture";
  files: {
    pick: () => Promise<FileOpenResult[]>;
    open: (path: string) => Promise<FileOpenResult>;
    write: (
      path: string,
      text: string,
      opts: { encoding: string; eol: "LF" | "CRLF" | "CR" },
    ) => Promise<{ size: number; mtimeMs: number }>;
    watch: (path: string, callback: (event: FileWatchEvent) => void) => () => void;
    recent: () => Promise<string[]>;
    reveal: (path: string) => void;
    onOpenRequest: (callback: (paths: string[]) => void) => () => void;
    pathForFile: (file: File) => string;
    openDropped: (paths: string[]) => Promise<string[]>;
  };
  run: {
    available: () => Promise<{ powershell: string | null; sqlcmd: string | null }>;
    start: (
      req: { language: RunLanguage; code: string; connectionString?: string | null },
      callback: (event: RunEvent) => void,
    ) => () => void;
  };
  sealed: { read: () => Promise<string | null>; write: (payload: string) => Promise<void> };
  /** Main window only. */
  clipboard: {
    writeSecret: (text: string, clearAfterMs: number) => Promise<SecretCopyResult>;
  };
  windowChrome: {
    /** Native caption buttons width in DIPs; 0 in windows without them. */
    controlsWidth: number;
    setColors: (colors: { color: string; symbolColor: string }) => Promise<void>;
    setMaterial: (
      material: "mica" | "none",
    ) => Promise<{ material: "mica" | "none"; supported: boolean }>;
  };
  screenClip: () => Promise<{ png: Uint8Array; text: string | null } | null>;
  ocr: (png: Uint8Array) => Promise<string>;
  prefs: {
    get: () => Promise<DesktopPrefsState>;
    set: (patch: Partial<DesktopPrefs>) => Promise<DesktopPrefsState>;
  };
  capture: {
    done: () => Promise<void>;
    close: () => Promise<void>;
    show: () => Promise<void>;
    onShow: (callback: () => void) => () => void;
    onHide: (callback: () => void) => () => void;
  };
  openExternal: (url: string) => Promise<void>;
  auth: DesktopAuthApi;
  log: (level: "info" | "warn" | "error", message: string) => Promise<void>;
  copyDiagnostics: () => Promise<DiagnosticsResult>;
  getAppUpdateState: () => Promise<AppUpdateState>;
  checkForAppUpdates: () => Promise<AppUpdateState>;
  downloadAppUpdate: () => Promise<AppUpdateState>;
  installAppUpdate: () => Promise<void>;
  onAppUpdateState: (callback: (state: AppUpdateState) => void) => () => void;
  /** Tray and deep-link actions ("new-note", "open-settings"). */
  onMenuAction: (callback: (action: MenuAction) => void) => () => void;
  /** joty://note/<id> */
  onOpenNote: (callback: (noteId: string) => void) => () => void;
  printNoteToPdf: () => Promise<{ ok: boolean; filePath?: string; error?: string }>;
  isQuickCapture: () => Promise<boolean>;
  closeQuickCapture: () => Promise<void>;
}

declare global {
  interface Window {
    joty?: JotyApi;
  }
}
