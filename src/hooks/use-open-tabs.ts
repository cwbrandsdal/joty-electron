import { useState, useCallback, useEffect } from "react";

interface OpenTab {
  id: string;
  title: string;
}

const STORAGE_KEY = "joty-open-tabs";
const ACTIVE_TAB_KEY = "joty-active-tab";

function loadTabs(): OpenTab[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function loadActiveTab(): string | null {
  try {
    return localStorage.getItem(ACTIVE_TAB_KEY);
  } catch {
    return null;
  }
}

export function useOpenTabs() {
  const [tabs, setTabs] = useState<OpenTab[]>(loadTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(loadActiveTab);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
  }, [tabs]);

  useEffect(() => {
    if (activeTabId) {
      localStorage.setItem(ACTIVE_TAB_KEY, activeTabId);
    } else {
      localStorage.removeItem(ACTIVE_TAB_KEY);
    }
  }, [activeTabId]);

  const openTab = useCallback(
    (id: string, title: string) => {
      setTabs((prev) => {
        if (prev.some((t) => t.id === id)) {
          return prev.map((t) => (t.id === id ? { ...t, title } : t));
        }
        return [...prev, { id, title }];
      });
      setActiveTabId(id);
    },
    [],
  );

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          const idx = prev.findIndex((t) => t.id === id);
          const newActive = next[Math.min(idx, next.length - 1)]?.id ?? null;
          setActiveTabId(newActive);
        }
        return next;
      });
    },
    [activeTabId],
  );

  const closeAll = useCallback(() => {
    setTabs([]);
    setActiveTabId(null);
  }, []);

  const closeOthers = useCallback(
    (id: string) => {
      setTabs((prev) => prev.filter((t) => t.id === id));
      setActiveTabId(id);
    },
    [],
  );

  const closeToRight = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        const next = prev.slice(0, idx + 1);
        if (activeTabId && !next.some((t) => t.id === activeTabId)) {
          setActiveTabId(id);
        }
        return next;
      });
    },
    [activeTabId],
  );

  const updateTabTitle = useCallback((id: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  }, []);

  return {
    tabs,
    activeTabId,
    setActiveTabId,
    openTab,
    closeTab,
    closeAll,
    closeOthers,
    closeToRight,
    updateTabTitle,
  };
}
