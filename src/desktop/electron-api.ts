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

export interface JotyApi {
  getAppUpdateState: () => Promise<AppUpdateState>;
  checkForAppUpdates: () => Promise<AppUpdateState>;
  downloadAppUpdate: () => Promise<AppUpdateState>;
  installAppUpdate: () => Promise<void>;
  onAppUpdateState: (callback: (state: AppUpdateState) => void) => () => void;
  /** Provided by the application-menu preload bridge; absent in older shells. */
  onMenuAction?: (callback: (action: MenuAction) => void) => () => void;
}

declare global {
  interface Window {
    joty?: JotyApi;
  }
}
