import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { API_BASE } from './api';

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

      toggleDiffPanel() { set((s) => ({ diffPanelOpen: !s.diffPanelOpen })); },

      toggleDiffPanelFullscreen() { set((s) => ({ diffPanelFullscreen: !s.diffPanelFullscreen })); },

      toggleDiffFileList() { set((s) => ({ diffFileListOpen: !s.diffFileListOpen })); },

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
      }),
    },
  ),
);
