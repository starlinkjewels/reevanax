import { create } from "zustand";

export interface Tab {
  id: string;
  title: string;
  path: string;
}

interface WorkspaceState {
  tabs: Tab[];
  activeId: string | null;
  openTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  globalSearchOpen: boolean;
  setGlobalSearch: (v: boolean) => void;
  quickAddOpen: null | "sale" | "purchase";
  setQuickAdd: (v: null | "sale" | "purchase") => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  /** Off-canvas drawer state on mobile — separate from `sidebarCollapsed`
   * (the desktop icon-only mode) since the two are mutually irrelevant: a
   * phone never shows the collapse button, and a laptop never opens a
   * drawer. */
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;
  toggleMobileNav: () => void;
}

const SIDEBAR_KEY = "bz.sidebarCollapsed";
const initialCollapsed = (() => {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
})();

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tabs: [],
  activeId: null,
  globalSearchOpen: false,
  quickAddOpen: null,
  sidebarCollapsed: initialCollapsed,
  openTab: (tab) => {
    const exists = get().tabs.find((t) => t.id === tab.id);
    if (exists) {
      set({ activeId: tab.id });
    } else {
      set({ tabs: [...get().tabs, tab], activeId: tab.id });
    }
  },
  closeTab: (id) => {
    const tabs = get().tabs.filter((t) => t.id !== id);
    const activeId = get().activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : get().activeId;
    set({ tabs, activeId });
  },
  setActive: (id) => set({ activeId: id }),
  setGlobalSearch: (v) => set({ globalSearchOpen: v }),
  setQuickAdd: (v) => set({ quickAddOpen: v }),
  toggleSidebar: () => {
    const v = !get().sidebarCollapsed;
    set({ sidebarCollapsed: v });
    try {
      localStorage.setItem(SIDEBAR_KEY, v ? "1" : "0");
    } catch {}
  },
  setSidebarCollapsed: (v) => {
    set({ sidebarCollapsed: v });
    try {
      localStorage.setItem(SIDEBAR_KEY, v ? "1" : "0");
    } catch {}
  },
  mobileNavOpen: false,
  setMobileNavOpen: (v) => set({ mobileNavOpen: v }),
  toggleMobileNav: () => set({ mobileNavOpen: !get().mobileNavOpen }),
}));
