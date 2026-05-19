import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { CreateNoteRequest, UpdateNoteRequest, NoteSummaryDto } from "@/types/api";

export function useNotes(params?: {
  query?: string;
  pinned?: boolean;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: ["notes", params],
    queryFn: () => api.getNotes(params),
  });
}

export function useNote(id: string | null) {
  return useQuery({
    queryKey: ["note", id],
    queryFn: () => api.getNote(id!),
    enabled: !!id,
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateNoteRequest) => api.createNote(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateNoteRequest }) =>
      api.updateNote(id, data),
    onSuccess: (updatedNote) => {
      queryClient.setQueryData(["note", updatedNote.id], updatedNote);
      // Optimistically update list items and move the edited note to the top
      queryClient.setQueriesData<{ items: NoteSummaryDto[] }>(
        { queryKey: ["notes"] },
        (old) => {
          if (!old) return old;
          const updated = old.items
            .map((item) =>
              item.id === updatedNote.id
                ? {
                    ...item,
                    title: updatedNote.title,
                    isPinned: updatedNote.isPinned,
                    updatedUtc: updatedNote.updatedUtc,
                  }
                : item,
            )
            .sort(
              (a, b) =>
                new Date(b.updatedUtc).getTime() -
                new Date(a.updatedUtc).getTime(),
            );
          return { ...old, items: updated };
        },
      );
    },
  });
}

export function useDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteNote(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ["note", id] });
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      queryClient.invalidateQueries({ queryKey: ["notes-archived"] });
      queryClient.invalidateQueries({ queryKey: ["notes-deleted"] });
    },
  });
}

export function usePinNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.pinNote(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      queryClient.invalidateQueries({ queryKey: ["note", id] });
    },
  });
}

export function useUnpinNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.unpinNote(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      queryClient.invalidateQueries({ queryKey: ["note", id] });
    },
  });
}

export function useArchivedNotes(params?: {
  query?: string;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: ["notes-archived", params],
    queryFn: () => api.getArchivedNotes(params),
  });
}

export function useDeletedNotes(params?: {
  query?: string;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: ["notes-deleted", params],
    queryFn: () => api.getDeletedNotes(params),
  });
}

export function useArchiveNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveNote(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ["note", id] });
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      queryClient.invalidateQueries({ queryKey: ["notes-archived"] });
    },
  });
}

export function useUnarchiveNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.unarchiveNote(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      queryClient.invalidateQueries({ queryKey: ["notes-archived"] });
    },
  });
}

export function useRestoreNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.restoreNote(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      queryClient.invalidateQueries({ queryKey: ["notes-deleted"] });
    },
  });
}

export function useHardDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.hardDeleteNote(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ["note", id] });
      queryClient.invalidateQueries({ queryKey: ["notes-deleted"] });
    },
  });
}

export function useGenerateTitle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.generateTitle(id),
    onSuccess: (updatedNote) => {
      queryClient.setQueryData(["note", updatedNote.id], updatedNote);
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });
}
