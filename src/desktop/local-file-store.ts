import type { LocalFilesSnapshot } from "@/platform/platform";
import "./electron-api";

let snapshot: LocalFilesSnapshot = { files: [], openedId: null, openSequence: 0, ready: false };
const listeners = new Set<() => void>();
let started = false;
function update(next: LocalFilesSnapshot) {
  snapshot = next;
  if (next.ready)
    for (const id of fileCopies.keys()) {
      if (!next.files.some((file) => file.id === id)) fileCopies.delete(id);
    }
  for (const listener of listeners) listener();
}

export const localFileStore = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    if (!started && window.joty?.files) {
      started = true;
      window.joty.files.onList(update);
      void window.joty.files
        .list()
        .then(update)
        .catch(() => update({ ...snapshot, ready: true }));
      window.addEventListener("beforeunload", (event) => {
        // The main process decides whether a prompt is needed. Always check
        // open files, including edits still in transit from background tabs.
        if (snapshot.files.length) {
          event.preventDefault();
          event.returnValue = "";
        }
      });
    }
    return () => {
      listeners.delete(listener);
    };
  },
  close: async (ids: string[]) => (await window.joty?.files?.close(ids)) ?? false,
  save: async (id: string) => await window.joty?.files?.save(id),
};

// Keep explicit copy/retry state when the editor unmounts on a tab switch.
export const fileCopies = new Map<
  string,
  {
    request?: { id: string; title: string; body: string };
    note?: { id: string; title: string };
  }
>();
