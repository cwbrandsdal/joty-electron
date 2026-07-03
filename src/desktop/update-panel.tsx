import { useState, useEffect } from "react";
import { RefreshCw, Download, RotateCcw, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import type { AppUpdateState } from "./electron-api";

const DEFAULT_STATE: AppUpdateState = { phase: "unsupported", currentVersion: "0.0.0" };

/** The auto-update status + actions block, shown inside desktop settings. */
export function UpdatePanel() {
  const [state, setState] = useState<AppUpdateState>(DEFAULT_STATE);
  const bridgeAvailable = typeof window.joty !== "undefined";

  useEffect(() => {
    if (!bridgeAvailable) return;
    window.joty!.getAppUpdateState().then(setState);
    const unsub = window.joty!.onAppUpdateState(setState);
    return unsub;
  }, [bridgeAvailable]);

  return (
    <div className="rounded-md border border-border bg-panel">
      <div className="p-4">
        <div className="flex items-center gap-3">
          <StatusIcon phase={state.phase} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              <StatusLabel state={state} />
            </p>
            <p className="text-xs text-ink-muted mt-0.5">Version {state.currentVersion}</p>
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
              {state.bytesPerSecond ? ` — ${formatBytes(state.bytesPerSecond)}/s` : ""}
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-border p-4 flex items-center gap-2">
        {(state.phase === "idle" || state.phase === "not-available" || state.phase === "error") && (
          <ActionButton
            icon={<RefreshCw size={12} />}
            onClick={() => void window.joty?.checkForAppUpdates()}
          >
            Check for updates
          </ActionButton>
        )}
        {state.phase === "checking" && (
          <button
            disabled
            className="flex items-center gap-2 rounded-md bg-accent/50 px-3 py-1.5 text-xs font-medium text-white"
          >
            <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> Checking…
          </button>
        )}
        {state.phase === "available" && (
          <ActionButton
            icon={<Download size={12} />}
            onClick={() => void window.joty?.downloadAppUpdate()}
          >
            Download update {state.availableVersion}
          </ActionButton>
        )}
        {state.phase === "downloaded" && (
          <ActionButton
            icon={<RotateCcw size={12} />}
            onClick={() => void window.joty?.installAppUpdate()}
          >
            Restart to install {state.availableVersion}
          </ActionButton>
        )}
        {state.phase === "unsupported" && (
          <p className="text-xs text-ink-muted">Updates are only available in packaged builds.</p>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
    >
      {icon}
      {children}
    </button>
  );
}

function StatusIcon({ phase }: { phase: AppUpdateState["phase"] }) {
  switch (phase) {
    case "checking":
    case "downloading":
      return (
        <Loader2
          size={18}
          className="text-accent animate-spin motion-reduce:animate-none shrink-0"
        />
      );
    case "available":
      return <Download size={18} className="text-accent shrink-0" />;
    case "downloaded":
    case "not-available":
      return <CheckCircle2 size={18} className="text-success shrink-0" />;
    case "error":
      return <XCircle size={18} className="text-warning shrink-0" />;
    default:
      return <RefreshCw size={18} className="text-ink-muted shrink-0" />;
  }
}

function StatusLabel({ state }: { state: AppUpdateState }) {
  switch (state.phase) {
    case "idle":
      return "No update check performed yet";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Update ${state.availableVersion} is available`;
    case "not-available":
      return "You're on the latest version";
    case "downloading":
      return `Downloading update ${state.availableVersion}…`;
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
