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

export interface JotyApi {
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
