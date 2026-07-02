import { useState } from "react";
import { Search, Pin, FileText, Plus, Feather, X, Archive, Trash2, ArchiveRestore, RotateCcw, Trash, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { Kbd } from "@/components/ui/kbd";
import { api } from "@/api/client";
import type { NoteSummaryDto } from "@/types/api";

export type SidebarView = "notes" | "archive" | "trash";

interface SidebarProps {
  notes: NoteSummaryDto[];
  archivedNotes: NoteSummaryDto[];
  deletedNotes: NoteSummaryDto[];
  activeNoteId: string | null;
  isLoading: boolean;
  isArchivedLoading: boolean;
  isDeletedLoading: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectNote: (id: string, title: string) => void;
  onNewNote: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  sidebarView: SidebarView;
  onSidebarViewChange: (view: SidebarView) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onUnarchive: (id: string) => void;
  onRestore: (id: string) => void;
  onHardDelete: (id: string) => void;
}

export function Sidebar({
  notes,
  archivedNotes,
  deletedNotes,
  activeNoteId,
  isLoading,
  isArchivedLoading,
  isDeletedLoading,
  searchQuery,
  onSearchChange,
  onSelectNote,
  onNewNote,
  mobileOpen,
  onMobileClose,
  sidebarView,
  onSidebarViewChange,
  onArchive,
  onDelete,
  onUnarchive,
  onRestore,
  onHardDelete,
}: SidebarProps) {
  const [searchFocused, setSearchFocused] = useState(false);

  const pinnedNotes = notes.filter((n) => n.isPinned);
  const unpinnedNotes = notes.filter((n) => !n.isPinned);

  function handleSelectNote(id: string, title: string) {
    onSelectNote(id, title);
    onMobileClose();
  }

  const sidebarContent = (
    <aside
      className={cn(
        "h-full flex flex-col bg-panel border-r border-border",
        "max-md:w-full",
        "md:w-72",
      )}
    >
      {/* Header */}
      <div className="p-4 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-accent rounded-sm flex items-center justify-center">
            <Feather size={16} className="text-white" />
          </div>
          <h1 className="text-xl font-display font-bold tracking-tight text-ink">
            Joty
          </h1>
        </div>
        <div className="flex items-center gap-1">
          {sidebarView === "notes" && (
            <button
              onClick={onNewNote}
              className="p-2 rounded-sm hover:bg-hover text-ink-muted hover:text-ink transition-colors cursor-pointer"
              title="New note (Ctrl+N)"
            >
              <Plus size={18} />
            </button>
          )}
          <button
            onClick={onMobileClose}
            className="p-2 rounded-sm hover:bg-hover text-ink-muted hover:text-ink transition-colors cursor-pointer md:hidden"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* View switcher */}
      <div className="px-3 pt-3 pb-1">
        <div className="flex items-center gap-0.5 bg-panel-alt rounded-sm border border-border p-0.5">
          <ViewTab
            icon={<FileText size={12} />}
            label="Notes"
            active={sidebarView === "notes"}
            onClick={() => onSidebarViewChange("notes")}
          />
          <ViewTab
            icon={<Archive size={12} />}
            label="Archive"
            active={sidebarView === "archive"}
            onClick={() => onSidebarViewChange("archive")}
          />
          <ViewTab
            icon={<Trash2 size={12} />}
            label="Trash"
            active={sidebarView === "trash"}
            onClick={() => onSidebarViewChange("trash")}
          />
        </div>
      </div>

      {/* Search */}
      <div className="p-3">
        <div
          className={cn(
            "flex items-center gap-2 px-3 h-9 bg-panel-alt border rounded-sm transition-all",
            searchFocused
              ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]"
              : "border-border",
          )}
        >
          <Search size={14} className="text-ink-muted shrink-0" />
          <input
            type="text"
            placeholder="Search notes..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-muted outline-none"
            id="sidebar-search"
          />
          <Kbd className="hidden md:inline-flex">Ctrl+F</Kbd>
        </div>
      </div>

      {/* Content based on view */}
      <div className="flex-1 overflow-y-auto">
        {sidebarView === "notes" && (
          <NotesView
            notes={notes}
            pinnedNotes={pinnedNotes}
            unpinnedNotes={unpinnedNotes}
            isLoading={isLoading}
            searchQuery={searchQuery}
            activeNoteId={activeNoteId}
            onSelectNote={handleSelectNote}
            onArchive={onArchive}
            onDelete={onDelete}
          />
        )}
        {sidebarView === "archive" && (
          <ArchiveView
            notes={archivedNotes}
            isLoading={isArchivedLoading}
            searchQuery={searchQuery}
            activeNoteId={activeNoteId}
            onSelectNote={handleSelectNote}
            onUnarchive={onUnarchive}
            onDelete={onDelete}
          />
        )}
        {sidebarView === "trash" && (
          <TrashView
            notes={deletedNotes}
            isLoading={isDeletedLoading}
            searchQuery={searchQuery}
            activeNoteId={activeNoteId}
            onSelectNote={handleSelectNote}
            onRestore={onRestore}
            onHardDelete={onHardDelete}
          />
        )}
      </div>

      {/* Backfill embeddings */}
      <BackfillButton />
    </aside>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden md:flex h-full">{sidebarContent}</div>

      {/* Mobile sidebar — overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div
            className="absolute inset-0 bg-ink/50 backdrop-blur-sm"
            onClick={onMobileClose}
          />
          <div className="relative w-80 max-w-[85vw] h-full shadow-xl">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}

function ViewTab({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded-sm text-xs font-medium transition-colors cursor-pointer",
        active
          ? "bg-page text-ink shadow-sm"
          : "text-ink-muted hover:text-ink-secondary",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function NotesView({
  notes,
  pinnedNotes,
  unpinnedNotes,
  isLoading,
  searchQuery,
  activeNoteId,
  onSelectNote,
  onArchive,
  onDelete,
}: {
  notes: NoteSummaryDto[];
  pinnedNotes: NoteSummaryDto[];
  unpinnedNotes: NoteSummaryDto[];
  isLoading: boolean;
  searchQuery: string;
  activeNoteId: string | null;
  onSelectNote: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (isLoading) {
    return <div className="p-4 text-sm text-ink-muted">Loading...</div>;
  }
  if (notes.length === 0) {
    return (
      <div className="p-4 text-sm text-ink-muted">
        {searchQuery ? "No notes found" : "No notes yet. Create one!"}
      </div>
    );
  }

  const noteActions = (noteId: string): NoteAction[] => [
    {
      icon: <Archive size={13} />,
      title: "Archive",
      onClick: () => onArchive(noteId),
    },
    {
      icon: <Trash2 size={13} />,
      title: "Delete",
      onClick: () => onDelete(noteId),
      danger: true,
    },
  ];

  return (
    <>
      {pinnedNotes.length > 0 && (
        <div className="px-3 pt-2 pb-1">
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-ink-muted uppercase tracking-widest">
            <Pin size={10} />
            Pinned
          </div>
          {pinnedNotes.map((note) => (
            <NoteItemWithActions
              key={note.id}
              note={note}
              isActive={note.id === activeNoteId}
              onSelect={onSelectNote}
              actions={noteActions(note.id)}
              showPin
            />
          ))}
        </div>
      )}
      {unpinnedNotes.length > 0 && (
        <div className="px-3 pt-2 pb-1">
          {pinnedNotes.length > 0 && (
            <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-ink-muted uppercase tracking-widest">
              <FileText size={10} />
              Notes
            </div>
          )}
          {unpinnedNotes.map((note) => (
            <NoteItemWithActions
              key={note.id}
              note={note}
              isActive={note.id === activeNoteId}
              onSelect={onSelectNote}
              actions={noteActions(note.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ArchiveView({
  notes,
  isLoading,
  searchQuery,
  activeNoteId,
  onSelectNote,
  onUnarchive,
  onDelete,
}: {
  notes: NoteSummaryDto[];
  isLoading: boolean;
  searchQuery: string;
  activeNoteId: string | null;
  onSelectNote: (id: string, title: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (isLoading) {
    return <div className="p-4 text-sm text-ink-muted">Loading...</div>;
  }
  if (notes.length === 0) {
    return (
      <div className="p-4 text-sm text-ink-muted">
        {searchQuery ? "No archived notes found" : "No archived notes"}
      </div>
    );
  }
  return (
    <div className="px-3 pt-2 pb-1">
      {notes.map((note) => (
        <NoteItemWithActions
          key={note.id}
          note={note}
          isActive={note.id === activeNoteId}
          onSelect={onSelectNote}
          actions={[
            {
              icon: <ArchiveRestore size={13} />,
              title: "Unarchive",
              onClick: () => onUnarchive(note.id),
            },
            {
              icon: <Trash2 size={13} />,
              title: "Delete",
              onClick: () => onDelete(note.id),
              danger: true,
            },
          ]}
        />
      ))}
    </div>
  );
}

function TrashView({
  notes,
  isLoading,
  searchQuery,
  activeNoteId,
  onSelectNote,
  onRestore,
  onHardDelete,
}: {
  notes: NoteSummaryDto[];
  isLoading: boolean;
  searchQuery: string;
  activeNoteId: string | null;
  onSelectNote: (id: string, title: string) => void;
  onRestore: (id: string) => void;
  onHardDelete: (id: string) => void;
}) {
  if (isLoading) {
    return <div className="p-4 text-sm text-ink-muted">Loading...</div>;
  }
  if (notes.length === 0) {
    return (
      <div className="p-4 text-sm text-ink-muted">
        {searchQuery ? "No deleted notes found" : "Trash is empty"}
      </div>
    );
  }
  return (
    <div className="px-3 pt-2 pb-1">
      {notes.map((note) => (
        <NoteItemWithActions
          key={note.id}
          note={note}
          isActive={note.id === activeNoteId}
          onSelect={onSelectNote}
          actions={[
            {
              icon: <RotateCcw size={13} />,
              title: "Restore",
              onClick: () => onRestore(note.id),
            },
            {
              icon: <Trash size={13} />,
              title: "Delete permanently",
              onClick: () => onHardDelete(note.id),
              danger: true,
            },
          ]}
        />
      ))}
    </div>
  );
}

interface NoteAction {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}

function NoteItemWithActions({
  note,
  isActive,
  onSelect,
  actions,
  showPin,
}: {
  note: NoteSummaryDto;
  isActive: boolean;
  onSelect: (id: string, title: string) => void;
  actions: NoteAction[];
  showPin?: boolean;
}) {
  const timeAgo = formatRelativeTime(note.updatedUtc);

  return (
    <div
      className={cn(
        "relative flex items-center rounded-sm transition-all group",
        isActive
          ? "bg-accent-soft text-accent border-l-2 border-l-accent"
          : "text-ink-secondary hover:bg-hover",
      )}
    >
      <button
        onClick={() => onSelect(note.id, note.title)}
        title={note.title}
        className="flex-1 text-left px-3 py-2.5 min-w-0 cursor-pointer"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium truncate">{note.title}</span>
          {showPin && note.isPinned && <Pin size={11} className="text-accent shrink-0" />}
        </div>
        <div className="text-xs text-ink-muted mt-0.5">{timeAgo}</div>
      </button>
      <div className="absolute right-0 top-0 bottom-0 flex items-center gap-0.5 pr-2 pl-4 bg-gradient-to-l from-50% from-hover to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
        {actions.map((action) => (
          <button
            key={action.title}
            onClick={(e) => {
              e.stopPropagation();
              action.onClick();
            }}
            title={action.title}
            className={cn(
              "p-1.5 rounded-sm transition-colors cursor-pointer",
              action.danger
                ? "hover:bg-danger/10 hover:text-danger text-ink-muted"
                : "hover:bg-hover hover:text-ink text-ink-muted",
            )}
          >
            {action.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

function BackfillButton() {
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");
  const [result, setResult] = useState<{ total: number; updated: number; failed: number; skipped: number } | null>(null);

  async function handleBackfill() {
    setStatus("loading");
    setResult(null);
    try {
      const res = await api.backfillEmbeddings();
      setResult(res);
      setStatus("done");
    } catch {
      setStatus("idle");
    }
  }

  return (
    <div className="p-3 border-t border-border">
      <button
        onClick={handleBackfill}
        disabled={status === "loading"}
        className={cn(
          "w-full flex items-center justify-center gap-2 h-8 rounded-sm text-xs font-medium transition-colors cursor-pointer",
          status === "loading"
            ? "bg-panel-alt text-ink-muted cursor-wait"
            : "bg-panel-alt border border-border text-ink-secondary hover:bg-hover hover:text-ink",
        )}
      >
        <Sparkles size={13} />
        {status === "loading" ? "Generating embeddings..." : "Backfill embeddings"}
      </button>
      {result && (
        <div className="mt-2 text-[11px] text-ink-muted text-center">
          {result.updated} updated, {result.skipped} skipped, {result.failed} failed
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}
