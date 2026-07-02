import { useState, useEffect } from "react";
import { ArrowLeft, RefreshCw, Download, RotateCcw, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import type { AppUpdateState } from "@/types/electron-api";

const DEFAULT_STATE: AppUpdateState = {
  phase: "unsupported",
  currentVersion: "0.0.0",
};

interface SettingsPageProps {
  onBack: () => void;
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  const [state, setState] = useState<AppUpdateState>(DEFAULT_STATE);
  const bridgeAvailable = typeof window.joty !== "undefined";

  useEffect(() => {
    if (!bridgeAvailable) return;
    window.joty!.getAppUpdateState().then(setState);
    const unsub = window.joty!.onAppUpdateState(setState);
    return unsub;
  }, [bridgeAvailable]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <header className="h-12 flex items-center gap-3 px-4 bg-panel border-b border-border shrink-0">
        <button
          onClick={onBack}
          className="p-1.5 rounded-sm hover:bg-hover text-ink-muted hover:text-ink transition-colors cursor-pointer"
          title="Back"
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-sm font-display font-semibold text-ink">Settings</h2>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto p-6 space-y-8">
          {/* About section */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-4">About</h3>
            <div className="bg-panel border border-border rounded-md p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-ink">Joty</p>
                  <p className="text-xs text-ink-muted mt-0.5">Version {state.currentVersion}</p>
                </div>
              </div>
            </div>
          </section>

          {/* Updates section */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-4">Updates</h3>
            <div className="bg-panel border border-border rounded-md divide-y divide-border">
              {/* Status */}
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <StatusIcon phase={state.phase} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">
                        <StatusLabel state={state} />
                      </p>
                      {state.checkedAt && (
                        <p className="text-xs text-ink-muted mt-0.5">
                          Last checked {formatTime(state.checkedAt)}
                        </p>
                      )}
                      {state.phase === "error" && state.error && (
                        <p className="text-xs text-warning mt-1">{state.error}</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Download progress */}
                {state.phase === "downloading" && (
                  <div className="mt-3">
                    <div className="w-full h-1.5 bg-panel-alt rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all duration-300"
                        style={{ width: `${state.percent ?? 0}%` }}
                      />
                    </div>
                    <p className="text-xs text-ink-muted mt-1.5">
                      {Math.round(state.percent ?? 0)}%
                      {state.bytesPerSecond
                        ? ` — ${formatBytes(state.bytesPerSecond)}/s`
                        : ""}
                    </p>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="p-4 flex items-center gap-2">
                {(state.phase === "idle" ||
                  state.phase === "not-available" ||
                  state.phase === "error") && (
                  <button
                    onClick={() => void window.joty?.checkForAppUpdates()}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors cursor-pointer"
                  >
                    <RefreshCw size={12} />
                    Check for updates
                  </button>
                )}
                {state.phase === "checking" && (
                  <button
                    disabled
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-accent/50 text-white cursor-not-allowed"
                  >
                    <Loader2 size={12} className="animate-spin" />
                    Checking...
                  </button>
                )}
                {state.phase === "available" && (
                  <button
                    onClick={() => void window.joty?.downloadAppUpdate()}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors cursor-pointer"
                  >
                    <Download size={12} />
                    Download update {state.availableVersion}
                  </button>
                )}
                {state.phase === "downloaded" && (
                  <button
                    onClick={() => void window.joty?.installAppUpdate()}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors cursor-pointer"
                  >
                    <RotateCcw size={12} />
                    Restart to install {state.availableVersion}
                  </button>
                )}
                {state.phase === "unsupported" && (
                  <p className="text-xs text-ink-muted">
                    Updates are only available in packaged builds.
                  </p>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ phase }: { phase: AppUpdateState["phase"] }) {
  switch (phase) {
    case "checking":
    case "downloading":
      return <Loader2 size={18} className="text-accent animate-spin shrink-0" />;
    case "available":
      return <Download size={18} className="text-accent shrink-0" />;
    case "downloaded":
      return <CheckCircle2 size={18} className="text-success shrink-0" />;
    case "error":
      return <XCircle size={18} className="text-warning shrink-0" />;
    case "not-available":
      return <CheckCircle2 size={18} className="text-success shrink-0" />;
    default:
      return <RefreshCw size={18} className="text-ink-muted shrink-0" />;
  }
}

function StatusLabel({ state }: { state: AppUpdateState }) {
  switch (state.phase) {
    case "idle":
      return "No update check performed yet";
    case "checking":
      return "Checking for updates...";
    case "available":
      return `Update ${state.availableVersion} is available`;
    case "not-available":
      return "You're on the latest version";
    case "downloading":
      return `Downloading update ${state.availableVersion}...`;
    case "downloaded":
      return `Update ${state.availableVersion} is ready to install`;
    case "error":
      return "Update check failed";
    case "unsupported":
      return "Development build";
    default:
      return "Unknown";
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
