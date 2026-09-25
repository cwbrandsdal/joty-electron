import type { MenuAction } from "@/platform/platform";

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

export interface DesktopSettings {
  launchAtLogin: boolean;
  minimizeToTray: boolean;
  autoDownloadUpdates: boolean;
  quickCaptureShortcut: string;
  zoomFactor: number;
}

export interface PdfExportResult {
  ok: boolean;
  filePath?: string;
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

export interface JotyApi {
  /** Main-process authentication bridge (absent in shells older than 1.4). */
  auth?: DesktopAuthApi;
  /** Append to the main-process log (absent in shells older than 1.5). */
  log?: (level: "info" | "warn" | "error", message: string) => Promise<void>;
  copyDiagnostics?: () => Promise<DiagnosticsResult>;
  getAppUpdateState: () => Promise<AppUpdateState>;
  checkForAppUpdates: () => Promise<AppUpdateState>;
  downloadAppUpdate: () => Promise<AppUpdateState>;
  installAppUpdate: () => Promise<void>;
  onAppUpdateState: (callback: (state: AppUpdateState) => void) => () => void;
  /** Provided by the application-menu preload bridge; absent in older shells. */
  onMenuAction?: (callback: (action: MenuAction) => void) => () => void;
  onOpenNote?: (callback: (noteId: string) => void) => () => void;
  getSettings: () => Promise<DesktopSettings>;
  updateSettings: (partial: Partial<DesktopSettings>) => Promise<DesktopSettings>;
  printNoteToPdf: () => Promise<PdfExportResult>;
  isQuickCapture: () => Promise<boolean>;
  closeQuickCapture: () => Promise<void>;
}

declare global {
  interface Window {
    joty?: JotyApi;
  }
}
