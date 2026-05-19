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
      try {
        await window.grove.stateSet(legacy);
      } catch {}
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
  // `grove/<animal>-<hash>` branch the fork was created on. The user is free
  // to `git switch` away from it inside the worktree — this field never
  // updates, it captures origin only.
  forkBranch?: string;
  forkedFromId?: string;
}

interface State {
  groups: Group[];
  tabs: Tab[];
  groupOrder: string[];
  tabOrderByGroup: Record<string, string[]>;
  activeTabId: string | null;
  sidebarOpen: boolean;
  // Right-panel host state. activePanelId is the registry id (e.g. 'diff',
  // 'files', 'browser', or an extension id) of the panel currently open; null
  // = closed. Mutually exclusive — only one panel at a time.
  activePanelId: string | null;
  // Per-panel fullscreen pref, keyed by panel id. Survives panel switches.
  panelFullscreen: Record<string, boolean>;
  diffFileListOpen: boolean;
  fileBrowserListOpen: boolean;
  fileBrowserRequest: { path: string; kind: 'file' | 'dir'; nonce: number } | null;
  browserPanelListOpen: boolean;
  browserPanelUrl: string | null;
  browserHistory: Array<{ url: string; visitedAt: number; cwd: string }>;
  autoEditCwdGroupId: string | null;
  runningCmds: Record<string, string>;
  // Transient — not persisted across reloads.
  unreadTabs: Record<string, true>;
  // Empty string = use the default CSS stack defined in styles.css.
  monoFontFamily: string;
  monoFontSize: number;
}

interface Actions {
  newGroup(name?: string | undefined, cwd?: string): string;
  renameGroup(id: string, name: string): void;
  setGroupCwd(id: string, cwd: string): void;
  removeGroup(id: string): void;
  toggleGroup(id: string): void;
  forkGroup(sourceGroupId: string): Promise<{ id: string } | { error: string }>;
  closeFork(
    id: string,
    force?: boolean,
  ): Promise<{ ok: true } | { needsConfirm: true; status: WorktreeStatus } | { error: string }>;
  _dropGroup(id: string): void;
  newTab(groupId?: string, title?: string): string;
  closeTab(id: string): void;
  renameTab(id: string, title: string): void;
  setTabColor(id: string, color: TabColor): void;
  setActiveTab(id: string | null): void;
  moveTab(tabId: string, targetGroupId: string, targetIndex: number): void;
  reorderGroups(newOrder: string[]): void;
  toggleSidebar(): void;
  // Generic right-panel host actions, keyed by registry panel id.
  openPanel(id: string): void;
  closePanel(): void;
  togglePanel(id: string): void;
  togglePanelFullscreen(id: string): void;
  toggleDiffFileList(): void;
  toggleFileBrowserList(): void;
  openFileInBrowser(path: string, kind?: 'file' | 'dir'): void;
  consumeFileBrowserRequest(): void;
  toggleBrowserPanelList(): void;
  setBrowserPanelUrl(url: string | null): void;
  removeBrowserHistory(url: string, cwd?: string): void;
  setAutoEditCwdGroupId(id: string | null): void;
  setRunningCmd(tabId: string, cmd: string | null): void;
  markTabUnread(tabId: string): void;
  clearTabUnread(tabId: string): void;
  setMonoFontFamily(v: string): void;
  setMonoFontSize(n: number): void;
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
      activePanelId: null,
      panelFullscreen: {},
      diffFileListOpen: true,
      fileBrowserListOpen: true,
      fileBrowserRequest: null,
      browserPanelListOpen: true,
      browserPanelUrl: null,
      browserHistory: [],
      autoEditCwdGroupId: null,
      runningCmds: {},
      unreadTabs: {},
      monoFontFamily: '',
      monoFontSize: 13,

      newGroup(name, cwd = '~') {
        const id = uid();
        const resolvedName =
          name && name !== 'workspace' && name !== 'group' ? name : defaultGroupName(cwd);
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
        if (get().groupOrder.length <= 1) return;
        get()._dropGroup(id);
      },

      _dropGroup(id) {
        // PTY teardown is best-effort fire-and-forget; the state mutation
        // below removes the tabs in one shot so we never observe a state
        // where tabs reference a deleted group.
        const tabsInGroup = get().tabs.filter((t) => t.groupId === id);
        for (const t of tabsInGroup) {
          fetch(`${API_BASE}/session/${t.id}`, { method: 'DELETE' }).catch(() => {});
        }
        set((s) => {
          const tabs = s.tabs.filter((t) => t.groupId !== id);
          const runningCmds = { ...s.runningCmds };
          for (const t of tabsInGroup) delete runningCmds[t.id];
          let activeTabId = s.activeTabId;
          if (activeTabId && tabsInGroup.some((t) => t.id === activeTabId)) {
            activeTabId = tabs[0]?.id ?? null;
          }
          const tabOrderByGroup = { ...s.tabOrderByGroup };
          delete tabOrderByGroup[id];
          return {
            groups: s.groups.filter((g) => g.id !== id),
            groupOrder: s.groupOrder.filter((gid) => gid !== id),
            tabOrderByGroup,
            tabs,
            activeTabId,
            runningCmds,
          };
        });
      },

      toggleGroup(id) {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)),
        }));
      },

      async forkGroup(sourceGroupId) {
        const source = get().groups.find((g) => g.id === sourceGroupId);
        if (!source) return { error: 'Source workspace not found.' };
        if (!window.grove?.workspace) return { error: 'Forking requires the desktop app.' };
        const newId = uid();
        try {
          const res = await window.grove.workspace.fork({
            workspaceId: newId,
            sourceCwd: source.cwd,
          });
          set((s) => {
            // Slot the fork right after its source so the relationship is
            // visible in the sidebar; if the source is missing for some reason,
            // fall back to appending.
            const sourceIdx = s.groupOrder.indexOf(sourceGroupId);
            const order = [...s.groupOrder];
            if (sourceIdx >= 0) order.splice(sourceIdx + 1, 0, newId);
            else order.push(newId);
            return {
              groups: [
                ...s.groups,
                {
                  id: newId,
                  name: res.displayName,
                  cwd: res.worktreePath,
                  collapsed: false,
                  forkBranch: res.branch,
                  forkedFromId: sourceGroupId,
                },
              ],
              groupOrder: order,
              tabOrderByGroup: { ...s.tabOrderByGroup, [newId]: [] },
            };
          });
          return { id: newId };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },

      async closeFork(id, force) {
        const group = get().groups.find((g) => g.id === id);
        if (!group) return { error: 'Workspace not found.' };
        if (!group.forkedFromId) return { error: 'Not a fork — use Delete group instead.' };
        if (!window.grove?.workspace) return { error: 'Closing forks requires the desktop app.' };
        // Always confirm — closing a fork removes a worktree directory and
        // potentially the grove/* branch, both of which deserve a beat to
        // verify even when nothing is dirty.
        if (!force) {
          const status = await window.grove.workspace.status({ workspaceId: id });
          return {
            needsConfirm: true,
            status: status ?? {
              hasUncommitted: false,
              hasUnpushed: false,
              unpushedCount: 0,
              currentBranch: null,
            },
          };
        }
        try {
          await window.grove.workspace.close({ workspaceId: id, force });
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        get()._dropGroup(id);
        return { ok: true };
      },

      newTab(groupId, title) {
        const s = get();
        const gid =
          groupId ??
          s.groups.find(
            (g) =>
              g.id ===
              (s.activeTabId
                ? s.tabs.find((t) => t.id === s.activeTabId)?.groupId
                : s.groupOrder[0]),
          )?.id ??
          s.groupOrder[0];
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
          const { [id]: _unread, ...unreadTabs } = s.unreadTabs;
          return {
            tabs: remaining,
            tabOrderByGroup: newOrder,
            activeTabId: nextActive,
            runningCmds,
            unreadTabs,
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

      setActiveTab(id) {
        set((s) => {
          if (!id || !s.unreadTabs[id]) return { activeTabId: id };
          const { [id]: _, ...rest } = s.unreadTabs;
          return { activeTabId: id, unreadTabs: rest };
        });
      },

      markTabUnread(tabId) {
        set((s) => (s.unreadTabs[tabId] ? s : { unreadTabs: { ...s.unreadTabs, [tabId]: true } }));
      },

      clearTabUnread(tabId) {
        set((s) => {
          if (!s.unreadTabs[tabId]) return s;
          const { [tabId]: _, ...rest } = s.unreadTabs;
          return { unreadTabs: rest };
        });
      },

      moveTab(tabId, targetGroupId, targetIndex) {
        set((s) => {
          const tab = s.tabs.find((t) => t.id === tabId);
          if (!tab) return s;
          const oldGroup = tab.groupId;
          const oldOrder = (s.tabOrderByGroup[oldGroup] ?? []).filter((t) => t !== tabId);
          const targetOrder =
            oldGroup === targetGroupId ? oldOrder : [...(s.tabOrderByGroup[targetGroupId] ?? [])];
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

      reorderGroups(newOrder) {
        set({ groupOrder: newOrder });
      },

      toggleSidebar() {
        set((s) => ({ sidebarOpen: !s.sidebarOpen }));
      },

      // Right-side panels (Files, Diff, Browser, future extension panels) are
      // mutually exclusive — only one occupies the slot at a time so the
      // workspace never competes with more than one sibling pane.
      openPanel(id) {
        set({ activePanelId: id });
      },
      closePanel() {
        set({ activePanelId: null });
      },
      togglePanel(id) {
        set((s) => ({ activePanelId: s.activePanelId === id ? null : id }));
      },
      togglePanelFullscreen(id) {
        set((s) => ({
          panelFullscreen: { ...s.panelFullscreen, [id]: !s.panelFullscreen[id] },
        }));
      },

      toggleDiffFileList() {
        set((s) => ({ diffFileListOpen: !s.diffFileListOpen }));
      },

      toggleFileBrowserList() {
        set((s) => ({ fileBrowserListOpen: !s.fileBrowserListOpen }));
      },

      toggleBrowserPanelList() {
        set((s) => ({ browserPanelListOpen: !s.browserPanelListOpen }));
      },

      setBrowserPanelUrl(url) {
        set((s) => {
          if (!url) return { browserPanelUrl: null };
          // Normalize for the recents key only — strip a trailing slash on
          // the path (but never the slash that immediately follows the host)
          // so "http://x:3000/" and "http://x:3000" don't both pile up.
          const normalized = url
            .replace(/(.+?:\/\/[^/]+\/.+?)\/$/, '$1')
            .replace(/(.+?:\/\/[^/]+)\/$/, '$1');
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
        // Switch to Files panel and stamp a request the FileBrowserPanel
        // will consume on its next render.
        set({
          activePanelId: 'files',
          fileBrowserRequest: { path, kind, nonce: Date.now() },
        });
      },
      consumeFileBrowserRequest() {
        set({ fileBrowserRequest: null });
      },

      setAutoEditCwdGroupId(id) {
        set({ autoEditCwdGroupId: id });
      },

      setMonoFontFamily(v) {
        set({ monoFontFamily: v });
      },
      setMonoFontSize(n) {
        set({ monoFontSize: Math.max(8, Math.min(28, Math.round(n))) });
      },

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
        activePanelId: s.activePanelId,
        panelFullscreen: s.panelFullscreen,
        diffFileListOpen: s.diffFileListOpen,
        fileBrowserListOpen: s.fileBrowserListOpen,
        browserPanelListOpen: s.browserPanelListOpen,
        browserPanelUrl: s.browserPanelUrl,
        browserHistory: s.browserHistory,
        monoFontFamily: s.monoFontFamily,
        monoFontSize: s.monoFontSize,
      }),
      version: 1,
      // Lift any prior per-panel boolean into the new activePanelId /
      // panelFullscreen shape so users coming from older builds don't see
      // a closed panel where they last left one open.
      migrate: (persistedState: unknown, _from: number) => {
        const s = (persistedState ?? {}) as Record<string, unknown>;
        if (s.activePanelId === undefined) {
          if (s.diffPanelOpen) s.activePanelId = 'diff';
          else if (s.fileBrowserOpen) s.activePanelId = 'files';
          else if (s.browserPanelOpen) s.activePanelId = 'browser';
          else s.activePanelId = null;
        }
        if (s.panelFullscreen === undefined) {
          s.panelFullscreen = {
            diff: !!s.diffPanelFullscreen,
            files: !!s.fileBrowserFullscreen,
            browser: !!s.browserPanelFullscreen,
          };
        }
        delete s.diffPanelOpen;
        delete s.fileBrowserOpen;
        delete s.browserPanelOpen;
        delete s.diffPanelFullscreen;
        delete s.fileBrowserFullscreen;
        delete s.browserPanelFullscreen;
        return s;
      },
    },
  ),
);
