import { useEffect, useRef, useState, useDeferredValue, useMemo, lazy, Suspense } from "react";
import type { PreviewMode } from "@/components/notes/preview-controls";
import { looksLikeMarkdown } from "@/lib/markdown-detect";
import { usePreviewSplit } from "@/hooks/use-preview-split";
import { toggleTaskAtLine } from "@/components/notes/editor/markdown-commands";
import { cn } from "@/lib/cn";
import { FileText, FolderOpen, Save, Upload, RotateCcw } from "lucide-react";
import { CodeMirrorEditor } from "@/components/notes/editor/CodeMirrorEditor";
import { Button } from "@/components/ui/button";
import { useEditorPrefs } from "@/hooks/use-editor-prefs";
import { useJotyAuth } from "@/auth/joty-auth";
import { api } from "@/api/client";
import type { LocalFileDocument } from "./electron-api";
import { fileCopies } from "./local-file-store";
import { useQueryClient } from "@tanstack/react-query";
import { insertNoteIntoListCaches } from "@/hooks/use-notes";

const noLinks = () => [];
const MarkdownPreview = lazy(() =>
  import("@/components/notes/markdown-preview").then((m) => ({ default: m.MarkdownPreview })),
);

export function LocalFilePage({
  id,
  previewMode,
  onOpenNote,
}: {
  id: string;
  previewMode: PreviewMode;
  onOpenNote: (id: string, title: string) => void;
}) {
  const [prefs] = useEditorPrefs();
  const { user, signIn } = useJotyAuth();
  const queryClient = useQueryClient();
  const [document, setDocument] = useState<LocalFileDocument | null>(null);
  const [body, setBody] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [copyNote, setCopyNote] = useState(() => fileCopies.get(id)?.note);
  const copying = useRef(false);
  const bridge = window.joty?.files;
  const deferredBody = useDeferredValue(body);
  const isMarkdown = useMemo(
    () => /\.(md|markdown)$/i.test(document?.name ?? "") || looksLikeMarkdown(deferredBody),
    [document?.name, deferredBody],
  );
  const showPreview = previewMode === "on" || (previewMode === "auto" && isMarkdown);
  const { splitRef, dragRatio, ratio, startSplitDrag, resetSplit } = usePreviewSplit();

  function changeBody(value: string) {
    bridge?.updateDraft(id, value);
    setBody(value);
  }

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge
      .get(id)
      .then((doc) => {
        if (!active) return;
        setDocument(doc);
        setBody(doc.body);
        setSavedBody(doc.savedBody);
        setError(doc.error);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    const unsubscribeState = bridge.onState((doc) => {
      if (doc.id !== id) return;
      setSavedBody(doc.savedBody);
      setError(doc.error);
    });
    const keydown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        void bridge.save(id).catch((e: Error) => setError(e.message));
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      active = false;
      unsubscribeState();
      window.removeEventListener("keydown", keydown);
    };
  }, [bridge, id]);

  async function save() {
    try {
      await bridge?.save(id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function reload() {
    setReloading(true);
    try {
      const doc = await bridge?.reload(id);
      if (doc) {
        setDocument(doc);
        setBody(doc.body);
        setSavedBody(doc.savedBody);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setReloading(false);
    }
  }

  async function copyIntoJoty() {
    if (!document || !user || copying.current) return;
    if (!fileCopies.get(id)?.request && body.length > 1_000_000) {
      setError(
        "Joty notes support up to 1,000,000 characters. Shorten the text before copying it into Joty.",
      );
      return;
    }
    copying.current = true;
    setBusy(true);
    setError(null);
    try {
      // Keep the same snapshot and id on retry if a response was lost.
      const copy = fileCopies.get(id) ?? {};
      copy.request ??= {
        id: crypto.randomUUID(),
        title: document.name.replace(/\.[^.]+$/, "") || document.name,
        body,
      };
      fileCopies.set(id, copy);
      const note = await api.createNote(copy.request);
      copy.note = { id: note.id, title: note.title };
      setCopyNote(copy.note);
      queryClient.setQueryData(["note", note.id], note);
      insertNoteIntoListCaches(queryClient, note);
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
    } catch {
      setError(
        "Couldn't copy into Joty. Check your connection and try again. Your local file is unchanged; retry will copy the same text.",
      );
    } finally {
      copying.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="flex-1 min-h-0 flex flex-col bg-page text-ink">
      <header className="shrink-0 border-b border-border bg-panel px-5 py-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-ink-secondary">
          <FileText size={16} />
          <span className="font-semibold">Local file</span>
          <span>· Not saved in Joty</span>
        </div>
        <div>
          <h1 className="font-display text-xl font-semibold">
            {document?.name ?? "Opening file…"}
          </h1>
          <p className="text-xs text-ink-muted break-all mt-1" title={document?.path}>
            {document?.path}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void bridge?.open()}>
            <FolderOpen size={15} />
            Open file…
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={!document || body === savedBody}
            title="Save to original file (Ctrl+S)"
          >
            <Save size={15} />
            Save file
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void reload()}
            disabled={!document || reloading}
            title="Reload from disk"
          >
            <RotateCcw size={15} />
            Reload
          </Button>
          <div className="flex-1" />
          {copyNote ? (
            <Button size="sm" onClick={() => onOpenNote(copyNote.id, copyNote.title)}>
              Open Joty copy
            </Button>
          ) : user ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void copyIntoJoty()}
              disabled={!document || busy}
            >
              <Upload size={15} />
              {busy ? "Copying…" : "Copy into Joty"}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => void signIn()}>
              Sign in to copy into Joty
            </Button>
          )}
        </div>
        {copyNote && (
          <p role="status" className="text-sm text-ink-secondary">
            Copied into Joty. The Joty copy and this file are now independent.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </header>
      <div ref={splitRef} className="flex-1 min-h-0 flex p-3" inert={reloading}>
        <section
          className={cn("h-full min-w-0", !showPreview && "flex-1")}
          style={
            showPreview ? { flex: `0 0 ${ratio * 100}%`, maxWidth: `${ratio * 100}%` } : undefined
          }
          aria-label="Local file editor"
        >
          {document && (
            <CodeMirrorEditor
              value={body}
              onChange={changeBody}
              getLinkTargets={noLinks}
              prefs={prefs}
              stateKey={id}
              autoFocus
            />
          )}
        </section>
        {showPreview && document && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize preview"
              title="Drag to resize · double-click to reset"
              onPointerDown={startSplitDrag}
              onDoubleClick={resetSplit}
              className="group flex w-3 shrink-0 cursor-col-resize items-stretch justify-center select-none"
            >
              <div
                className={cn(
                  "w-px transition-colors",
                  dragRatio !== null ? "bg-accent" : "bg-border group-hover:bg-accent",
                )}
              />
            </div>
            <section
              aria-label="Markdown preview"
              className="joty-preview-pane flex-1 min-w-0 overflow-y-auto pb-4 pl-3"
            >
              <div className="prose-joty">
                {deferredBody ? (
                  <Suspense fallback={<p className="text-ink-muted">Loading preview…</p>}>
                    <MarkdownPreview
                      body={deferredBody}
                      onToggleTaskAtLine={
                        deferredBody === body
                          ? (line) => {
                              const next = toggleTaskAtLine(body, line);
                              if (next !== null) changeBody(next);
                            }
                          : undefined
                      }
                    />
                  </Suspense>
                ) : (
                  <p className="text-ink-muted italic">Nothing to preview</p>
                )}
              </div>
            </section>
          </>
        )}
      </div>
      <footer
        className="shrink-0 border-t border-border px-5 py-2 text-xs text-ink-muted"
        role="status"
      >
        {body !== savedBody
          ? "Unsaved changes · Ctrl+S saves to the original file"
          : "Saved on this computer · Ctrl+S to save edits"}
      </footer>
    </main>
  );
}
