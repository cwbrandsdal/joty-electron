import { useState, useEffect, useMemo } from "react";
import { Download } from "lucide-react";
import type { AppUpdateState } from "./electron-api";

const DEFAULT_STATE: AppUpdateState = {
  phase: "unsupported",
  currentVersion: "0.0.0",
};

export function UpdateBanner() {
  const [state, setState] = useState<AppUpdateState>(DEFAULT_STATE);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!window.joty) return;

    window.joty.getAppUpdateState().then(setState);
    const unsub = window.joty.onAppUpdateState(setState);
    return unsub;
  }, []);

  const noticeKey = useMemo(() => {
    if (state.phase === "available" || state.phase === "downloaded") {
      return `${state.phase}:${state.availableVersion ?? "unknown"}`;
    }
    return null;
  }, [state.phase, state.availableVersion]);

  const show = noticeKey !== null && noticeKey !== dismissedKey;

  if (!show) return null;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 bg-accent/10 border-b border-accent/20 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <Download size={14} className="text-accent shrink-0" />
        <span className="text-ink-secondary truncate">
          {state.phase === "downloaded"
            ? `Update ${state.availableVersion ?? ""} is ready — restart to install`
            : `Update ${state.availableVersion ?? ""} is available`}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {state.phase === "available" && (
          <button
            className="px-3 py-1 text-xs font-medium rounded bg-accent text-white hover:bg-accent/90 transition-colors cursor-pointer"
            onClick={() => void window.joty?.downloadAppUpdate()}
          >
            Download update
          </button>
        )}
        {state.phase === "downloaded" && (
          <button
            className="px-3 py-1 text-xs font-medium rounded bg-accent text-white hover:bg-accent/90 transition-colors cursor-pointer"
            onClick={() => void window.joty?.installAppUpdate()}
          >
            Restart to install
          </button>
        )}
        <button
          className="px-2 py-1 text-xs text-ink-muted hover:text-ink-secondary transition-colors cursor-pointer"
          onClick={() => setDismissedKey(noticeKey)}
        >
          Later
        </button>
      </div>
    </div>
  );
}
