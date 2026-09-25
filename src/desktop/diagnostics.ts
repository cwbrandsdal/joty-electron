import { getOutbox } from "@/lib/outbox";

/**
 * Forwards the shared app's sync problems to the main-process log so a
 * "copy diagnostics" report includes them. Only statuses and reasons are
 * logged — never note content.
 */
export function installDesktopDiagnostics(): void {
  const bridge = window.joty;
  if (!bridge?.log) return;

  let lastError: string | null = null;
  getOutbox().subscribe((event) => {
    if (event.type === "dropped") {
      void bridge.log!(
        "warn",
        `[sync] dropped queued save for note ${event.entry.noteId}: ${event.reason}`,
      );
    } else if (event.type === "status") {
      const { error, pending, unauthorized } = event.status;
      if (error && error !== lastError) {
        void bridge.log!(
          "warn",
          `[sync] paused (${pending} pending${unauthorized ? ", unauthorized" : ""}): ${error}`,
        );
      } else if (!error && lastError) {
        void bridge.log!("info", "[sync] recovered");
      }
      lastError = error;
    }
  });

  window.addEventListener("error", (event) => {
    void bridge.log!("error", `[window] ${event.message} (${event.filename}:${event.lineno})`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    void bridge.log!("error", `[window] unhandled rejection: ${reason}`);
  });
}
