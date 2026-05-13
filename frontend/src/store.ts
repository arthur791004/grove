import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { API_BASE } from './api';

// Persist via Electron IPC → ~/Library/Application Support/Grove/grove-state.json.
// Origin-independent so dev (http://127.0.0.1:5173) and packaged (file://)
// renderers share the same state. Falls back to localStorage in non-Electron
// contexts (e.g. running Vite in a browser tab) and migrates legacy
// localStorage data into the file on first read.
const groveStorage = createJSONStorage(() => ({
  getItem: async (name: string) => {
    if (!window.grove?.stateGet) return localStorage.getItem(name);
    const fromFile = await window.grove.stateGet();
    if (fromFile != null) return fromFile;
    const legacy = localStorage.getItem(name);
    if (legacy) {
      try { await window.grove.stateSet(legacy); } catch {}
      return legacy;
    }
    return null;
  },
  setItem: async (name: string, value: string) => {
    if (!window.grove?.stateSet) {
      localStorage.setItem(name, value);
      return;
    }
    await window.grove.stateSet(value);
  },
  removeItem: async (name: string) => {
    if (!window.grove?.stateSet) {
      localStorage.removeItem(name);
      return;
    }
    await window.grove.stateSet('');
  },
}));

export type TabColor = 'default' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan';

const RANDOM_TAB_COLORS: TabColor[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
const pickRandomColor = (): TabColor =>
  RANDOM_TAB_COLORS[Math.floor(Math.random() * RANDOM_TAB_COLORS.length)];

export interface Tab {
  id: string;
  title: string;
  color: TabColor;
  groupId: string;
}

export interface Group {
  id: string;
  name: string;
  cwd: string;
  collapsed: boolean;
}

interface State {
  groups: Group[];
  tabs: Tab[];
  groupOrder: string[];
  tabOrderByGroup: Record<string, string[]>;
  activeTabId: string | null;
  sidebarOpen: boolean;
  diffPanelOpen: boolean;
  diffPanelFullscreen: boolean;
  diffFileListOpen: boolean;
  fileBrowserOpen: boolean;
  fileBrowserFullscreen: boolean;
  fileBrowserListOpen: boolean;
  fileBrowserRequest: { path: string; kind: 'file' | 'dir'; nonce: number } | null;
  browserPanelOpen: boolean;
  browserPanelFullscreen: boolean;
  browserPanelListOpen: boolean;
  browserPanelUrl: string | null;
  browserHistory: Array<{ url: string; visitedAt: number; cwd: string }>;
  autoEditCwdGroupId: string | null;
  runningCmds: Record<string, string>;
}

interface Actions {
  newGroup(name?: string | undefined, cwd?: string): string;
  renameGroup(id: string, name: string): void;
  setGroupCwd(id: string, cwd: string): void;
  removeGroup(id: string): void;
  toggleGroup(id: string): void;
  newTab(groupId?: string, title?: string): string;
  closeTab(id: string): void;
  renameTab(id: string, title: string): void;
  setTabColor(id: string, color: TabColor): void;
  setActiveTab(id: string | null): void;
  moveTab(tabId: string, targetGroupId: string, targetIndex: number): void;
  reorderGroups(newOrder: string[]): void;
  toggleSidebar(): void;
  toggleDiffPanel(): void;
  toggleDiffPanelFullscreen(): void;
  toggleDiffFileList(): void;
  toggleFileBrowser(): void;
  toggleFileBrowserFullscreen(): void;
  toggleFileBrowserList(): void;
  openFileInBrowser(path: string, kind?: 'file' | 'dir'): void;
  consumeFileBrowserRequest(): void;
  toggleBrowserPanel(): void;
  toggleBrowserPanelFullscreen(): void;
  toggleBrowserPanelList(): void;
  setBrowserPanelUrl(url: string | null): void;
  removeBrowserHistory(url: string, cwd?: string): void;
  setAutoEditCwdGroupId(id: string | null): void;
  setRunningCmd(tabId: string, cmd: string | null): void;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export function defaultGroupName(cwd: string): string {
  const trimmed = cwd.replace(/\/$/, '');
  if (trimmed === '~' || trimmed === '' || trimmed === '/') return 'Home';
  const base = trimmed.split('/').filter(Boolean).pop();
  return base || 'Home';
}

export const useStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      groups: [{ id: 'default', name: 'Home', cwd: '~', collapsed: false }],
      tabs: [],
      groupOrder: ['default'],
      tabOrderByGroup: { default: [] },
      activeTabId: null,
      sidebarOpen: true,
      diffPanelOpen: false,
      diffPanelFullscreen: false,
      diffFileListOpen: true,
      fileBrowserOpen: false,
      fileBrowserFullscreen: false,
      fileBrowserListOpen: true,
      fileBrowserRequest: null,
      browserPanelOpen: false,
      browserPanelFullscreen: false,
      browserPanelListOpen: true,
      browserPanelUrl: null,
      browserHistory: [],
      autoEditCwdGroupId: null,
      runningCmds: {},

      newGroup(name, cwd = '~') {
        const id = uid();
        const resolvedName = name && name !== 'workspace' && name !== 'group' ? name : defaultGroupName(cwd);
        set((s) => ({
          groups: [...s.groups, { id, name: resolvedName, cwd, collapsed: false }],
          groupOrder: [...s.groupOrder, id],
          tabOrderByGroup: { ...s.tabOrderByGroup, [id]: [] },
        }));
        get().newTab(id);
        return id;
      },

      renameGroup(id, name) {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
        }));
      },

      setGroupCwd(id, cwd) {
        set((s) => ({
          groups: s.groups.map((g) => {
            if (g.id !== id) return g;
            const looksAuto = g.name === defaultGroupName(g.cwd);
            return { ...g, cwd, name: looksAuto ? defaultGroupName(cwd) : g.name };
          }),
        }));
      },

      removeGroup(id) {
        const s = get();
        const tabsInGroup = s.tabs.filter((t) => t.groupId === id);
        tabsInGroup.forEach((t) => get().closeTab(t.id));
        if (s.groupOrder.length <= 1) return;
        set((s) => ({
          groups: s.groups.filter((g) => g.id !== id),
          groupOrder: s.groupOrder.filter((gid) => gid !== id),
          tabOrderByGroup: Object.fromEntries(
            Object.entries(s.tabOrderByGroup).filter(([gid]) => gid !== id),
          ),
        }));
      },

      toggleGroup(id) {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)),
        }));
      },

      newTab(groupId, title) {
        const s = get();
        const gid = groupId ?? s.groups.find((g) => g.id === (s.activeTabId
          ? s.tabs.find((t) => t.id === s.activeTabId)?.groupId
          : s.groupOrder[0]))?.id ?? s.groupOrder[0];
        const id = uid();
        const tab: Tab = { id, title: title ?? 'shell', color: pickRandomColor(), groupId: gid };
        set((st) => ({
          tabs: [...st.tabs, tab],
          tabOrderByGroup: {
            ...st.tabOrderByGroup,
            [gid]: [...(st.tabOrderByGroup[gid] ?? []), id],
          },
          activeTabId: id,
        }));
        return id;
      },

      closeTab(id) {
        fetch(`${API_BASE}/session/${id}`, { method: 'DELETE' }).catch(() => {});
        set((s) => {
          const tab = s.tabs.find((t) => t.id === id);
          if (!tab) return s;
          const orderForGroup = (s.tabOrderByGroup[tab.groupId] ?? []).filter((t) => t !== id);
          const newOrder = { ...s.tabOrderByGroup, [tab.groupId]: orderForGroup };
          const remaining = s.tabs.filter((t) => t.id !== id);
          let nextActive = s.activeTabId;
          if (s.activeTabId === id) {
            nextActive = orderForGroup[0] ?? remaining[0]?.id ?? null;
          }
          const runningCmds = { ...s.runningCmds };
          delete runningCmds[id];
          return {
            tabs: remaining,
            tabOrderByGroup: newOrder,
            activeTabId: nextActive,
            runningCmds,
          };
        });
      },

      renameTab(id, title) {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
        }));
      },

      setTabColor(id, color) {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, color } : t)),
        }));
      },

      setActiveTab(id) { set({ activeTabId: id }); },

      moveTab(tabId, targetGroupId, targetIndex) {
        set((s) => {
          const tab = s.tabs.find((t) => t.id === tabId);
          if (!tab) return s;
          const oldGroup = tab.groupId;
          const oldOrder = (s.tabOrderByGroup[oldGroup] ?? []).filter((t) => t !== tabId);
          const targetOrder = oldGroup === targetGroupId
            ? oldOrder
            : [...(s.tabOrderByGroup[targetGroupId] ?? [])];
          targetOrder.splice(targetIndex, 0, tabId);
          return {
            tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, groupId: targetGroupId } : t)),
            tabOrderByGroup: {
              ...s.tabOrderByGroup,
              [oldGroup]: oldOrder,
              [targetGroupId]: targetOrder,
            },
          };
        });
      },

      reorderGroups(newOrder) { set({ groupOrder: newOrder }); },

      toggleSidebar() { set((s) => ({ sidebarOpen: !s.sidebarOpen })); },

      // Right-side panels (diff, file browser, web browser) are mutually
      // exclusive — only one occupies the slot at a time so the workspace
      // never has to compete with more than one sibling pane.
      toggleDiffPanel() {
        set((s) => s.diffPanelOpen
          ? { diffPanelOpen: false }
          : { diffPanelOpen: true, fileBrowserOpen: false, browserPanelOpen: false });
      },

      toggleDiffPanelFullscreen() { set((s) => ({ diffPanelFullscreen: !s.diffPanelFullscreen })); },

      toggleDiffFileList() { set((s) => ({ diffFileListOpen: !s.diffFileListOpen })); },

      toggleFileBrowser() {
        set((s) => s.fileBrowserOpen
          ? { fileBrowserOpen: false }
          : { fileBrowserOpen: true, diffPanelOpen: false, browserPanelOpen: false });
      },

      toggleFileBrowserFullscreen() { set((s) => ({ fileBrowserFullscreen: !s.fileBrowserFullscreen })); },

      toggleFileBrowserList() { set((s) => ({ fileBrowserListOpen: !s.fileBrowserListOpen })); },

      toggleBrowserPanel() {
        set((s) => s.browserPanelOpen
          ? { browserPanelOpen: false }
          : { browserPanelOpen: true, diffPanelOpen: false, fileBrowserOpen: false });
      },

      toggleBrowserPanelFullscreen() { set((s) => ({ browserPanelFullscreen: !s.browserPanelFullscreen })); },

      toggleBrowserPanelList() { set((s) => ({ browserPanelListOpen: !s.browserPanelListOpen })); },

      setBrowserPanelUrl(url) {
        set((s) => {
          if (!url) return { browserPanelUrl: null };
          // Normalize for the recents key only — strip a trailing slash on
          // the path (but never the slash that immediately follows the host)
          // so "http://x:3000/" and "http://x:3000" don't both pile up.
          const normalized = url.replace(/(.+?:\/\/[^/]+\/.+?)\/$/, '$1').replace(/(.+?:\/\/[^/]+)\/$/, '$1');
          // Scope recents by the active tab's workspace cwd so each project
          // gets its own history. Falls back to '' when no active tab.
          const active = s.tabs.find((t) => t.id === s.activeTabId);
          const group = active ? s.groups.find((g) => g.id === active.groupId) : null;
          const cwd = group?.cwd ?? '';
          const rest = s.browserHistory.filter((h) => !(h.url === normalized && h.cwd === cwd));
          const next = [{ url: normalized, visitedAt: Date.now(), cwd }, ...rest].slice(0, 100);
          return { browserPanelUrl: normalized, browserHistory: next };
        });
      },
      removeBrowserHistory(url, cwd) {
        set((s) => ({
          browserHistory: s.browserHistory.filter(
            (h) => !(h.url === url && (cwd === undefined || h.cwd === cwd)),
          ),
        }));
      },

      openFileInBrowser(path, kind = 'file') {
        // Open the panel (closing the diff + browser panels) and stamp a
        // request the FileBrowserPanel will consume.
        set({
          fileBrowserOpen: true,
          diffPanelOpen: false,
          browserPanelOpen: false,
          fileBrowserRequest: { path, kind, nonce: Date.now() },
        });
      },
      consumeFileBrowserRequest() {
        set({ fileBrowserRequest: null });
      },

      setAutoEditCwdGroupId(id) { set({ autoEditCwdGroupId: id }); },

      setRunningCmd(tabId, cmd) {
        set((s) => {
          const cur = s.runningCmds[tabId];
          if (cmd === null) {
            if (cur === undefined) return s;
            const next = { ...s.runningCmds };
            delete next[tabId];
            return { runningCmds: next };
          }
          if (cur === cmd) return s;
          return { runningCmds: { ...s.runningCmds, [tabId]: cmd } };
        });
      },
    }),
    {
      name: 'grove-state',
      storage: groveStorage,
      partialize: (s) => ({
        groups: s.groups,
        tabs: s.tabs,
        groupOrder: s.groupOrder,
        tabOrderByGroup: s.tabOrderByGroup,
        activeTabId: s.activeTabId,
        sidebarOpen: s.sidebarOpen,
        diffPanelOpen: s.diffPanelOpen,
        diffPanelFullscreen: s.diffPanelFullscreen,
        diffFileListOpen: s.diffFileListOpen,
        fileBrowserOpen: s.fileBrowserOpen,
        fileBrowserFullscreen: s.fileBrowserFullscreen,
        fileBrowserListOpen: s.fileBrowserListOpen,
        browserPanelOpen: s.browserPanelOpen,
        browserPanelFullscreen: s.browserPanelFullscreen,
        browserPanelListOpen: s.browserPanelListOpen,
        browserPanelUrl: s.browserPanelUrl,
        browserHistory: s.browserHistory,
      }),
    },
  ),
);
