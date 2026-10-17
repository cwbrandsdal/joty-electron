import { useEffect, useRef, useState } from "react";
import { FileText, FolderOpen, Save, Upload, RotateCcw } from "lucide-react";
import { CodeMirrorEditor } from "@/components/notes/editor/CodeMirrorEditor";
import { Button } from "@/components/ui/button";
import { useEditorPrefs } from "@/hooks/use-editor-prefs";
import { useTheme } from "@/hooks/use-theme";
import { useJotyAuth } from "@/auth/joty-auth";
import { api } from "@/api/client";
import type { LocalFileDocument } from "./electron-api";

const noLinks = () => [];

export function LocalFilePage() {
  useTheme();
  const [prefs] = useEditorPrefs();
  const { user } = useJotyAuth();
  const [document, setDocument] = useState<LocalFileDocument | null>(null);
  const [body, setBody] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [copyId, setCopyId] = useState<string | null>(null);
  const dirty = useRef(false);
  const copying = useRef(false);
  const promotion = useRef<{ id: string; title: string; body: string } | null>(null);
  const bridge = window.joty?.files;

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge
      .get()
      .then((doc) => {
        if (!active) return;
        setDocument(doc);
        setBody(doc.body);
        setSavedBody(doc.savedBody);
        dirty.current = doc.body !== doc.savedBody;
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    const unsubscribeState = bridge.onState((doc) => {
      setSavedBody(doc.savedBody);
      setError(null);
    });
    const unsubscribeError = bridge.onError(setError);
    const unsubscribeSave = bridge.onSaveRequest(() => {
      void bridge.save().catch((e: Error) => setError(e.message));
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    const keydown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        void bridge.save().catch((e: Error) => setError(e.message));
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      active = false;
      unsubscribeState();
      unsubscribeError();
      unsubscribeSave();
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("keydown", keydown);
    };
  }, [bridge]);

  useEffect(() => {
    dirty.current = body !== savedBody;
  }, [body, savedBody]);

  async function save() {
    try {
      await bridge?.save();
    } catch (e) {
      setError(String(e));
    }
  }

  async function reload() {
    setReloading(true);
    try {
      const doc = await bridge?.reload();
      if (doc) {
        setDocument(doc);
        setBody(doc.body);
        setSavedBody(doc.savedBody);
        dirty.current = false;
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setReloading(false);
    }
  }

  async function copyIntoJoty() {
    if (!document || !user || copying.current) return;
    if (!promotion.current && body.length > 1_000_000) {
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
      promotion.current ??= {
        id: crypto.randomUUID(),
        title: document.name.replace(/\.[^.]+$/, "") || document.name,
        body,
      };
      const note = await api.createNote(promotion.current);
      setCopyId(note.id);
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
    <main className="h-dvh flex flex-col bg-page text-ink">
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
          {copyId ? (
            <Button size="sm" onClick={() => void bridge?.openNote(copyId)}>
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
            <Button variant="ghost" size="sm" onClick={() => void bridge?.showJoty()}>
              Sign in to copy into Joty
            </Button>
          )}
        </div>
        {copyId && (
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
      <section
        className="flex-1 min-h-0 overflow-auto p-3"
        aria-label="Local file editor"
        inert={reloading}
      >
        {document && (
          <CodeMirrorEditor
            value={body}
            onChange={(value) => {
              dirty.current = value !== savedBody;
              bridge?.updateDraft(value);
              setBody(value);
            }}
            getLinkTargets={noLinks}
            prefs={prefs}
            autoFocus
          />
        )}
      </section>
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
