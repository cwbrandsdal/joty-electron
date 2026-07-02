import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sparkles, Loader2 } from "lucide-react";
import { useNote, useUpdateNote, useGenerateTitle } from "@/hooks/use-notes";
import { useDebouncedCallback } from "@/hooks/use-debounce";

export type SaveStatus = "saved" | "saving" | "unsaved";

interface NoteEditorProps {
  noteId: string;
  mode: "edit" | "preview";
  onTitleChange?: (id: string, title: string) => void;
  onSaveStatusChange?: (status: SaveStatus) => void;
}

export function NoteEditor({ noteId, mode, onTitleChange, onSaveStatusChange }: NoteEditorProps) {
  const { data: note, isLoading } = useNote(noteId);
  const updateNote = useUpdateNote();
  const generateTitle = useGenerateTitle();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [, setSaveStatusLocal] = useState<SaveStatus>("saved");
  const [cursor, setCursor] = useState({ ln: 1, col: 1, pos: 0 });
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const lastSavedRef = useRef({ title: "", body: "" });
  const generatingTitleRef = useRef(false);
  const initializedNoteIdRef = useRef<string | null>(null);
  const cursorLnRef = useRef(1);

  // text-base (16px) * leading-relaxed (1.625) = 26px; p-2 = 8px
  const LINE_HEIGHT = 26;
  const PADDING_TOP = 8;

  const [lineHeights, setLineHeights] = useState<number[]>([LINE_HEIGHT]);
  const lineHeightsRef = useRef<number[]>([LINE_HEIGHT]);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const bodyTextRef = useRef(body);
  bodyTextRef.current = body;

  const syncHighlight = useCallback((scrollTop: number, ln: number) => {
    if (!highlightRef.current) return;
    const heights = lineHeightsRef.current;
    let top = PADDING_TOP;
    for (let i = 0; i < ln - 1 && i < heights.length; i++) {
      top += heights[i];
    }
    highlightRef.current.style.top = `${top - scrollTop}px`;
    highlightRef.current.style.height = `${(heights[ln - 1] || LINE_HEIGHT)}px`;
  }, []);

  const gutterHtml = useMemo(() =>
    lineHeights.map((h, i) =>
      `<div style="height:${h}px;line-height:${LINE_HEIGHT}px">${i + 1}</div>`
    ).join(''),
  [lineHeights]);

  const handleCursorChange = useCallback(() => {
    const ta = bodyRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const textBefore = body.slice(0, pos);
    const ln = textBefore.split("\n").length;
    const col = pos - textBefore.lastIndexOf("\n");
    cursorLnRef.current = ln;
    setCursor({ ln, col, pos });
    syncHighlight(ta.scrollTop, ln);
  }, [body, syncHighlight]);

  const handleScroll = useCallback(() => {
    const ta = bodyRef.current;
    if (!ta) return;
    if (gutterRef.current) {
      gutterRef.current.scrollTop = ta.scrollTop;
    }
    syncHighlight(ta.scrollTop, cursorLnRef.current);
  }, [syncHighlight]);

  // Measure wrapped line heights using a hidden mirror div
  const measureLines = useCallback(() => {
    const mirror = mirrorRef.current;
    const ta = bodyRef.current;
    if (!mirror || !ta) return;

    mirror.style.width = `${ta.clientWidth}px`;
    mirror.textContent = '';

    const lines = bodyTextRef.current.split("\n");
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line || '\u200b';
      mirror.appendChild(div);
    }

    const heights: number[] = [];
    for (let i = 0; i < mirror.children.length; i++) {
      heights.push((mirror.children[i] as HTMLElement).offsetHeight);
    }

    mirror.textContent = '';
    lineHeightsRef.current = heights;
    setLineHeights(heights);
    syncHighlight(ta.scrollTop, cursorLnRef.current);
  }, [syncHighlight]);

  useLayoutEffect(measureLines, [body, measureLines]);

  useEffect(() => {
    const ta = bodyRef.current;
    if (!ta) return;
    let frame: number;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measureLines);
    });
    observer.observe(ta);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [measureLines]);

  function setSaveStatus(status: SaveStatus) {
    setSaveStatusLocal(status);
    onSaveStatusChange?.(status);
  }

  // Load note data only on initial fetch or when switching notes
  useEffect(() => {
    if (note && initializedNoteIdRef.current !== noteId) {
      initializedNoteIdRef.current = noteId;
      setTitle(note.title);
      setBody(note.body);
      lastSavedRef.current = { title: note.title, body: note.body };
      setSaveStatus("saved");
    }
  }, [note, noteId]);

  const save = useCallback(
    async (newTitle: string, newBody: string) => {
      if (
        newTitle === lastSavedRef.current.title &&
        newBody === lastSavedRef.current.body
      ) {
        setSaveStatus("saved");
        return;
      }
      if (!newTitle.trim()) return;

      setSaveStatus("saving");
      try {
        await updateNote.mutateAsync({
          id: noteId,
          data: { title: newTitle, body: newBody },
        });
        lastSavedRef.current = { title: newTitle, body: newBody };
        setSaveStatus("saved");

        if (newTitle === "Untitled" && newBody.length >= 50 && !generatingTitleRef.current) {
          generatingTitleRef.current = true;
          try {
            const updated = await generateTitle.mutateAsync(noteId);
            setTitle(updated.title);
            onTitleChange?.(noteId, updated.title);
            lastSavedRef.current = { title: updated.title, body: newBody };
          } catch {
            // Title generation is best-effort; ignore failures
          } finally {
            generatingTitleRef.current = false;
          }
        }
      } catch {
        setSaveStatus("unsaved");
      }
    },
    [noteId, updateNote, generateTitle, onTitleChange],
  );

  const debouncedSave = useDebouncedCallback(
    (t: string, b: string) => save(t, b),
    800,
  );

  const handleTitleChange = (value: string) => {
    setTitle(value);
    setSaveStatus("unsaved");
    onTitleChange?.(noteId, value);
    debouncedSave(value, body);
  };

  const handleBodyChange = (value: string) => {
    setBody(value);
    setSaveStatus("unsaved");
    debouncedSave(title, value);
  };

  const handleRegenerateTitle = async () => {
    if (generatingTitleRef.current || !body.trim()) return;
    generatingTitleRef.current = true;
    setIsGenerating(true);
    try {
      const updated = await generateTitle.mutateAsync(noteId);
      setTitle(updated.title);
      onTitleChange?.(noteId, updated.title);
      lastSavedRef.current = { title: updated.title, body };
    } catch {
      // Best-effort; ignore failures
    } finally {
      generatingTitleRef.current = false;
      setIsGenerating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-muted">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!note) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-muted">
        Note not found
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Title */}
      <div className="px-4 sm:px-8 pt-6 sm:pt-8 pb-2 flex items-center gap-2">
        <input
          ref={titleRef}
          type="text"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="Untitled"
          className="flex-1 min-w-0 text-2xl sm:text-3xl font-display font-bold bg-transparent text-ink placeholder:text-border-strong outline-none p-2"
        />
        <button
          type="button"
          onClick={handleRegenerateTitle}
          disabled={isGenerating || !body.trim()}
          title="Generate title with AI"
          className="shrink-0 p-1.5 rounded-md text-ink-muted hover:text-accent hover:bg-surface-hover disabled:opacity-30 disabled:pointer-events-none transition-colors"
        >
          {isGenerating ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Sparkles size={16} />
          )}
        </button>
      </div>

      {/* Body */}
      <div className={`flex-1 px-4 sm:px-8 min-h-0 ${mode === "preview" ? "overflow-y-auto pb-4 sm:pb-8" : ""}`}>
        {mode === "edit" ? (
          <div className="flex h-full min-h-0">
            {/* Line number gutter */}
            <div
              ref={gutterRef}
              aria-hidden
              className="shrink-0 overflow-hidden select-none text-right text-xs font-mono text-ink-muted border-r border-border pr-2 pt-2 pb-2"
              style={{ width: "3rem" }}
              dangerouslySetInnerHTML={{ __html: gutterHtml }}
            />
            <div className="relative flex-1 min-w-0 overflow-hidden">
              {/* Hidden mirror for measuring wrapped line heights */}
              <div
                ref={mirrorRef}
                aria-hidden
                className="absolute invisible whitespace-pre-wrap break-words font-mono text-base leading-relaxed p-2"
                style={{ boxSizing: 'border-box' }}
              />
              {/* Current line highlight */}
              <div
                ref={highlightRef}
                className="absolute left-0 right-0 pointer-events-none bg-hover"
                style={{
                  top: `${PADDING_TOP}px`,
                  height: `${LINE_HEIGHT}px`,
                }}
              />
              <textarea
                ref={bodyRef}
                value={body}
                onChange={(e) => handleBodyChange(e.target.value)}
                onSelect={handleCursorChange}
                onClick={handleCursorChange}
                onKeyUp={handleCursorChange}
                onScroll={handleScroll}
                autoFocus
                placeholder="Start writing in markdown..."
                className="relative w-full h-full bg-transparent text-ink placeholder:text-border-strong outline-none resize-none text-base leading-relaxed font-mono p-2"
              />
            </div>
          </div>
        ) : (
          <div className="prose-joty">
            {body ? (
              <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
            ) : (
              <p className="text-ink-muted italic">Nothing to preview</p>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="shrink-0 flex items-center gap-4 px-4 sm:px-8 py-1 border-t border-border bg-panel-alt text-ink-muted text-xs font-mono select-none">
        <span>Length: {body.length.toLocaleString()}</span>
        <span>Lines: {lineHeights.length.toLocaleString()}</span>
        {mode === "edit" && (
          <>
            <span>Ln: {cursor.ln.toLocaleString()}</span>
            <span>Col: {cursor.col.toLocaleString()}</span>
            <span>Pos: {cursor.pos.toLocaleString()}</span>
          </>
        )}
      </div>
    </div>
  );
}
