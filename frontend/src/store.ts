import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TabColor = 'default' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan';

export interface Tab {
  id: string;
  title: string;
  color: TabColor;
  groupId: string;
}

export interface Group {
  id: string;
  name: string;
  collapsed: boolean;
}

interface State {
  groups: Group[];
  tabs: Tab[];
  groupOrder: string[];
  tabOrderByGroup: Record<string, string[]>;
  activeTabId: string | null;
  sidebarOpen: boolean;
}

interface Actions {
  newGroup(name?: string): string;
  renameGroup(id: string, name: string): void;
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
}

const uid = () => Math.random().toString(36).slice(2, 10);

export const useStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      groups: [{ id: 'default', name: 'default', collapsed: false }],
      tabs: [],
      groupOrder: ['default'],
      tabOrderByGroup: { default: [] },
      activeTabId: null,
      sidebarOpen: true,

      newGroup(name = 'group') {
        const id = uid();
        set((s) => ({
          groups: [...s.groups, { id, name, collapsed: false }],
          groupOrder: [...s.groupOrder, id],
          tabOrderByGroup: { ...s.tabOrderByGroup, [id]: [] },
        }));
        return id;
      },

      renameGroup(id, name) {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
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
        const tab: Tab = { id, title: title ?? 'shell', color: 'default', groupId: gid };
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
        fetch(`http://127.0.0.1:4317/session/${id}`, { method: 'DELETE' }).catch(() => {});
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
          return {
            tabs: remaining,
            tabOrderByGroup: newOrder,
            activeTabId: nextActive,
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
      }),
    },
  ),
);
