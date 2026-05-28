import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { API_BASE } from './api';
import type { LayoutNode, Pane, PaneKind } from './layout/types';
import {
  addPaneToLeaf,
  findLeaf,
  findLeafContaining,
  getAllLeaves,
  getAllPanes,
  hasPaneOfKind,
  makeLeaf,
  removePane,
  setActivePane,
  splitLeaf as splitLeafOp,
  splitRight,
  updateSplitSizes,
} from './layout/treeOps';

// Persist the workspace/tab state. The Electron app reads/writes
// ~/Library/Application Support/Grove/grove-state.json via IPC. The web build
// has no IPC bridge, so it reads/writes that *same file* through the daemon's
// /state endpoint — a browser or phone then sees the same workspaces as the
// desktop app. localStorage is only a fallback for when the daemon has no
// state yet or is unreachable.

// Web build only: the daemon mirrors the desktop app's grove-state.json.
async function fetchDaemonState(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/state`);
    if (!res.ok) return null;
    const json = (await res.json()) as { value?: unknown };
    return typeof json.value === 'string' ? json.value : null;
  } catch {
    return null;
  }
}

async function postDaemonState(value: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  } catch {
    /* daemon unreachable — localStorage already holds the value */
  }
}

const groveStorage = createJSONStorage(() => ({
  getItem: async (name: string) => {
    if (window.grove?.stateGet) {
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
    }
    const fromDaemon = await fetchDaemonState();
    if (fromDaemon != null) return fromDaemon;
    return localStorage.getItem(name);
  },
  setItem: async (name: string, value: string) => {
    if (window.grove?.stateSet) {
      await window.grove.stateSet(value);
      return;
    }
    localStorage.setItem(name, value);
    await postDaemonState(value);
  },
  removeItem: async (name: string) => {
    if (window.grove?.stateSet) {
      await window.grove.stateSet('');
      return;
    }
    localStorage.removeItem(name);
    await postDaemonState('');
  },
}));

export type TabColor = 'default' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan';
export type AgentState = 'working' | 'blocked';

export type NewTabMode = 'shell' | 'claude';

export type PinType = 'shell' | 'claude';
export type PinScope = 'global' | 'workspace';

// A one-click command or Claude prompt shown in the footer pin bar. Global
// pins show everywhere; workspace pins (groupId set) show only in their
// group. Display order is the pins[] array position within each scope — no
// separate order field.
export interface Pin {
  id: string;
  label: string;
  type: PinType;
  command: string;
  scope: PinScope;
  groupId?: string;
  // Hidden pins are kept (and still listed in the pin manager modal) but not
  // rendered in the strip or bound to a ⌘⇧N shortcut. Undefined = visible.
  hidden?: boolean;
}

const DEFAULT_PINS: Pin[] = [
  { id: 'pin-run-tests', label: 'run tests', type: 'shell', command: 'npm test', scope: 'global' },
  { id: 'pin-git-push', label: 'git push', type: 'shell', command: 'git push', scope: 'global' },
  {
    id: 'pin-explain-error',
    label: 'explain error',
    type: 'claude',
    command: 'explain the last error in the terminal',
    scope: 'global',
  },
  {
    id: 'pin-fix-lint',
    label: 'fix lint',
    type: 'claude',
    command: 'fix all lint errors',
    scope: 'global',
  },
  {
    id: 'pin-write-tests',
    label: 'write tests',
    type: 'claude',
    command: 'write tests for the code I just changed',
    scope: 'global',
  },
];

// One pickable answer: `label` is shown to the user, `send` is written to the
// pty (a digit for numbered menus, `y` / `n` for inline yes/no prompts).
export interface AgentPromptChoice {
  label: string;
  send: string;
}

export interface AgentPrompt {
  question: string;
  choices: AgentPromptChoice[];
}

const RANDOM_TAB_COLORS: TabColor[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
const pickRandomColor = (): TabColor =>
  RANDOM_TAB_COLORS[Math.floor(Math.random() * RANDOM_TAB_COLORS.length)];

export interface Tab {
  id: string;
  title: string;
  color: TabColor;
  groupId: string;
  // How the tab was opened. Drives the `claude` bootstrap and lets fork /
  // session-sharing logic find a workspace's Claude tab. Absent on tabs
  // persisted before this field existed — treat as 'shell'.
  kind?: 'claude' | 'shell';
  // The Claude Code session id this tab launched (`--session-id`) or joined
  // (`--resume`). Set once `claude` is bootstrapped; lets a later Claude tab
  // in the same workspace offer to join this session.
  claudeSessionId?: string;
  // Short task label shown on the agents-view card. Set when a Claude tab is
  // created from the agents view's "+ new agent" flow; absent on tabs that
  // were opened from the sidebar (where `title` plays the same role).
  agentLabel?: string;
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
  // Set once the first Claude tab in this fork has been seeded with the
  // parent workspace's context summary, so later Claude tabs don't re-inject.
  forkContextConsumed?: boolean;
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
  // Per-tab `claude` agent state pushed from the backend agent-state ticker.
  // Absent = no claude session running. Transient.
  agentStates: Record<string, AgentState>;
  // Most recent Claude assistant snippet per tab. Parallel to agentStates so
  // existing consumers (Sidebar chip) keep their simple shape.
  agentReplies: Record<string, string>;
  // Parsed permission prompt (question + numbered choices) when state is
  // `blocked`. Absent when Claude isn't on a menu we can parse.
  agentPrompts: Record<string, AgentPrompt>;
  // Transient — not persisted across reloads.
  unreadTabs: Record<string, true>;
  // Empty string = use the default CSS stack defined in styles.css.
  monoFontFamily: string;
  monoFontSize: number;
  newTabMode: NewTabMode;
  // Tabs awaiting the `claude` bootstrap on next replay-end. Not persisted —
  // a queued bootstrap is meaningless once the tab's pty is recreated fresh.
  claudeBootstrapTabs: Record<string, true>;
  // Footer pin bar. Flat list of global + workspace pins; the bar filters by
  // scope/groupId. Persisted. Seeded with DEFAULT_PINS on first launch — a
  // user who clears every pin persists `[]`, which is kept (not re-seeded).
  pins: Pin[];
  // Pre-filled draft to open the pin editor with (e.g. "Pin this command"
  // from a terminal block). Transient — the PinBar consumes and clears it.
  pendingPinDraft: Omit<Pin, 'id'> | null;
  // A pending New-session / Join-existing decision: set when a Claude tab is
  // bootstrapped into a workspace that already runs a Claude session, cleared
  // once SessionChoiceDialog launches `claude`. Transient.
  sessionChoice: SessionChoice | null;
  // Cross-workspace agents view: takes over the main content area when open.
  // Transient — opening it is always a deliberate action, no need to persist.
  agentsViewOpen: boolean;
  // Per-workspace pane tree. One LayoutNode per group; mutated alongside the
  // legacy tabs[] / activePanelId fields. LayoutHost reads from here so the
  // user can drag dividers, split panels off, and (slice 5) drag tabs
  // between leaves. The legacy fields stay in sync for unmigrated consumers
  // (Sidebar, AgentsView, useTabContext, …).
  layoutTreeByGroup: Record<string, LayoutNode>;
  // First message to send into a new Claude tab once its TUI is ready (state
  // first transitions to 'blocked' or 'working' with no pending message).
  // Keyed by tab id; consumed once on send.
  pendingFirstMessages: Record<string, string>;
}

export interface SessionChoice {
  tabId: string;
  // The existing session a "join" would `--resume`.
  joinSessionId: string;
  workspaceName: string;
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
  markForkContextConsumed(groupId: string): void;
  newTab(groupId?: string, title?: string, opts?: { mode?: NewTabMode }): string;
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
  setAgentState(
    tabId: string,
    state: AgentState | null,
    reply?: string | null,
    prompt?: AgentPrompt | null,
  ): void;
  markTabUnread(tabId: string): void;
  clearTabUnread(tabId: string): void;
  setMonoFontFamily(v: string): void;
  setMonoFontSize(n: number): void;
  setNewTabMode(v: NewTabMode): void;
  consumeClaudeBootstrap(tabId: string): boolean;
  setTabClaudeSession(tabId: string, sessionId: string): void;
  setSessionChoice(v: SessionChoice | null): void;
  openAgentsView(): void;
  closeAgentsView(): void;
  toggleAgentsView(): void;
  // Layout-tree mutations (slice 4+). Resize is wired in slice 3 so the
  // user-dragged divider persists across renders.
  resizeLayoutSplit(groupId: string, splitId: string, sizes: number[]): void;
  splitLeafInTree(groupId: string, leafId: string, dir: 'h' | 'v', pane: Pane, after: boolean): void;
  removePaneFromTree(groupId: string, paneId: string): void;
  setActivePaneInTree(groupId: string, paneId: string): void;
  setAgentLabel(tabId: string, label: string): void;
  setPendingFirstMessage(tabId: string, message: string): void;
  consumePendingFirstMessage(tabId: string): string | null;
  addPin(pin: Omit<Pin, 'id'>): void;
  removePin(id: string): void;
  updatePin(id: string, patch: Partial<Omit<Pin, 'id'>>): void;
  movePin(id: string, direction: -1 | 1): void;
  reorderPins(orderedIds: string[]): void;
  setPendingPinDraft(draft: Omit<Pin, 'id'> | null): void;
}

const uid = () => Math.random().toString(36).slice(2, 10);

function agentPromptsEqual(a: AgentPrompt | undefined, b: AgentPrompt | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.question !== b.question) return false;
  if (a.choices.length !== b.choices.length) return false;
  for (let i = 0; i < a.choices.length; i++) {
    if (a.choices[i].label !== b.choices[i].label) return false;
    if (a.choices[i].send !== b.choices[i].send) return false;
  }
  return true;
}

// Pick the workspace the active tab belongs to, or the first one if no
// active tab — panels open in that workspace's tree.
function activeGroupId(s: Pick<State, 'tabs' | 'activeTabId' | 'groupOrder'>): string | null {
  const tab = s.activeTabId ? s.tabs.find((t) => t.id === s.activeTabId) : null;
  return tab?.groupId ?? s.groupOrder[0] ?? null;
}

function panelTitle(id: string): string {
  if (id === 'diff') return 'Diff';
  if (id === 'files') return 'Files';
  if (id === 'browser') return 'Browser';
  return id;
}

function withPanelOpen(
  s: State,
  panelId: string,
): Pick<State, 'activePanelId' | 'layoutTreeByGroup'> {
  const gid = activeGroupId(s);
  if (!gid) return { activePanelId: panelId, layoutTreeByGroup: s.layoutTreeByGroup };
  const tree = s.layoutTreeByGroup[gid] ?? makeLeaf([]);
  if (getAllPanes(tree).some((p) => p.id === panelId)) {
    return { activePanelId: panelId, layoutTreeByGroup: s.layoutTreeByGroup };
  }
  const panelLeaf = makeLeaf([
    { id: panelId, kind: panelId as PaneKind, title: panelTitle(panelId) },
  ]);
  const nextTree = splitRight(tree, panelLeaf);
  return {
    activePanelId: panelId,
    layoutTreeByGroup: { ...s.layoutTreeByGroup, [gid]: nextTree },
  };
}

function withPanelClosed(s: State): Pick<State, 'activePanelId' | 'layoutTreeByGroup'> {
  const gid = activeGroupId(s);
  if (!gid || !s.activePanelId)
    return { activePanelId: null, layoutTreeByGroup: s.layoutTreeByGroup };
  const tree = s.layoutTreeByGroup[gid];
  if (!tree) return { activePanelId: null, layoutTreeByGroup: s.layoutTreeByGroup };
  const next = removePane(tree, s.activePanelId);
  return {
    activePanelId: null,
    layoutTreeByGroup: { ...s.layoutTreeByGroup, [gid]: next ?? makeLeaf([]) },
  };
}

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
      agentStates: {},
      agentReplies: {},
      agentPrompts: {},
      unreadTabs: {},
      monoFontFamily: '',
      monoFontSize: 13,
      newTabMode: 'shell',
      claudeBootstrapTabs: {},
      pins: DEFAULT_PINS,
      pendingPinDraft: null,
      sessionChoice: null,
      agentsViewOpen: false,
      pendingFirstMessages: {},
      layoutTreeByGroup: { default: makeLeaf([]) },

      newGroup(name, cwd = '~') {
        const id = uid();
        const resolvedName =
          name && name !== 'workspace' && name !== 'group' ? name : defaultGroupName(cwd);
        set((s) => ({
          groups: [...s.groups, { id, name: resolvedName, cwd, collapsed: false }],
          groupOrder: [...s.groupOrder, id],
          tabOrderByGroup: { ...s.tabOrderByGroup, [id]: [] },
          layoutTreeByGroup: { ...s.layoutTreeByGroup, [id]: makeLeaf([]) },
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
          const layoutTreeByGroup = { ...s.layoutTreeByGroup };
          delete layoutTreeByGroup[id];
          return {
            groups: s.groups.filter((g) => g.id !== id),
            groupOrder: s.groupOrder.filter((gid) => gid !== id),
            tabOrderByGroup,
            layoutTreeByGroup,
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

      markForkContextConsumed(groupId) {
        set((s) => ({
          groups: s.groups.map((g) =>
            g.id === groupId ? { ...g, forkContextConsumed: true } : g,
          ),
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
              layoutTreeByGroup: { ...s.layoutTreeByGroup, [newId]: makeLeaf([]) },
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

      newTab(groupId, title, opts) {
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
        const mode = opts?.mode ?? s.newTabMode;
        const tab: Tab = {
          id,
          title: title ?? mode,
          color: pickRandomColor(),
          groupId: gid,
          kind: mode === 'claude' ? 'claude' : 'shell',
        };
        set((st) => {
          const pane: Pane = {
            id,
            kind: (tab.kind ?? 'shell') as PaneKind,
            title: tab.title,
          };
          const tree = st.layoutTreeByGroup[gid] ?? makeLeaf([]);
          // Workspace leaf = the first leaf without panel panes; if none
          // exists yet (group started empty), create one.
          const workspaceLeaf =
            getAllLeaves(tree).find((l) =>
              l.panes.every((p) => p.kind === 'shell' || p.kind === 'claude'),
            ) ?? null;
          let nextTree = tree;
          if (workspaceLeaf) {
            nextTree = addPaneToLeaf(tree, workspaceLeaf.id, pane) as LayoutNode;
          } else {
            // No workspace leaf — make one and split it to the left of any
            // existing panels.
            const fresh = makeLeaf([pane]);
            nextTree = splitLeafOp(tree, getAllLeaves(tree)[0]!.id, 'h', fresh, false);
          }
          const next: Partial<State> = {
            tabs: [...st.tabs, tab],
            tabOrderByGroup: {
              ...st.tabOrderByGroup,
              [gid]: [...(st.tabOrderByGroup[gid] ?? []), id],
            },
            layoutTreeByGroup: { ...st.layoutTreeByGroup, [gid]: nextTree },
            activeTabId: id,
          };
          if (mode === 'claude') {
            next.claudeBootstrapTabs = { ...st.claudeBootstrapTabs, [id]: true };
          }
          return next;
        });
        return id;
      },

      closeTab(id) {
        fetch(`${API_BASE}/session/${id}`, { method: 'DELETE' }).catch(() => {});
        window.grove?.mcp?.deleteConfig(id).catch(() => {});
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
          const { [id]: _agent, ...agentStates } = s.agentStates;
          const { [id]: _reply, ...agentReplies } = s.agentReplies;
          const { [id]: _prompt, ...agentPrompts } = s.agentPrompts;
          const { [id]: _boot, ...claudeBootstrapTabs } = s.claudeBootstrapTabs;
          const { [id]: _pfm, ...pendingFirstMessages } = s.pendingFirstMessages;
          const tree = s.layoutTreeByGroup[tab.groupId];
          const nextTree = tree ? removePane(tree, id) : null;
          const layoutTreeByGroup = { ...s.layoutTreeByGroup };
          // A group always keeps at least one leaf — even if empty — so
          // newTab can target it.
          layoutTreeByGroup[tab.groupId] = nextTree ?? makeLeaf([]);
          return {
            tabs: remaining,
            tabOrderByGroup: newOrder,
            layoutTreeByGroup,
            activeTabId: nextActive,
            runningCmds,
            unreadTabs,
            agentStates,
            agentReplies,
            agentPrompts,
            claudeBootstrapTabs,
            pendingFirstMessages,
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
          let layoutTreeByGroup = s.layoutTreeByGroup;
          if (id) {
            const tab = s.tabs.find((t) => t.id === id);
            if (tab) {
              const tree = s.layoutTreeByGroup[tab.groupId];
              if (tree) {
                const next = setActivePane(tree, id);
                if (next !== tree) {
                  layoutTreeByGroup = { ...s.layoutTreeByGroup, [tab.groupId]: next };
                }
              }
            }
          }
          if (!id || !s.unreadTabs[id]) return { activeTabId: id, layoutTreeByGroup };
          const { [id]: _, ...rest } = s.unreadTabs;
          return { activeTabId: id, unreadTabs: rest, layoutTreeByGroup };
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

      // Panels (Files, Diff, Browser, …) live as panes in the active group's
      // layout tree. Slice 3 keeps `activePanelId` as a top-level field for
      // backward compat with consumers that haven't migrated; opening a panel
      // also adds a panel leaf to the right of the active group's tree, and
      // closing one removes that pane. Multiple panels per group are not
      // surfaced in the UI yet but the tree already supports them.
      openPanel(id) {
        set((s) => withPanelOpen(s, id));
      },
      closePanel() {
        set((s) => withPanelClosed(s));
      },
      togglePanel(id) {
        set((s) => (s.activePanelId === id ? withPanelClosed(s) : withPanelOpen(s, id)));
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
        set((s) => ({
          ...withPanelOpen(s, 'files'),
          fileBrowserRequest: { path, kind, nonce: Date.now() },
        }));
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
      setNewTabMode(v) {
        set({ newTabMode: v });
      },
      consumeClaudeBootstrap(tabId) {
        if (!get().claudeBootstrapTabs[tabId]) return false;
        set((s) => {
          const { [tabId]: _drop, ...rest } = s.claudeBootstrapTabs;
          return { claudeBootstrapTabs: rest };
        });
        return true;
      },
      setTabClaudeSession(tabId, sessionId) {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, claudeSessionId: sessionId } : t)),
        }));
      },
      setSessionChoice(v) {
        set({ sessionChoice: v });
      },
      openAgentsView() {
        set({ agentsViewOpen: true });
      },
      closeAgentsView() {
        set({ agentsViewOpen: false });
      },
      toggleAgentsView() {
        set((s) => ({ agentsViewOpen: !s.agentsViewOpen }));
      },
      resizeLayoutSplit(groupId, splitId, sizes) {
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          const next = updateSplitSizes(tree, splitId, sizes);
          if (next === tree) return s;
          return { layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: next } };
        });
      },
      splitLeafInTree(groupId, leafId, dir, pane, after) {
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          const newLeaf = makeLeaf([pane]);
          const next = splitLeafOp(tree, leafId, dir, newLeaf, after);
          return { layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: next } };
        });
      },
      removePaneFromTree(groupId, paneId) {
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          const next = removePane(tree, paneId);
          return {
            layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: next ?? makeLeaf([]) },
          };
        });
      },
      setActivePaneInTree(groupId, paneId) {
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          const next = setActivePane(tree, paneId);
          if (next === tree) return s;
          return { layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: next } };
        });
      },
      setAgentLabel(tabId, label) {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, agentLabel: label } : t)),
        }));
      },
      setPendingFirstMessage(tabId, message) {
        set((s) => ({
          pendingFirstMessages: { ...s.pendingFirstMessages, [tabId]: message },
        }));
      },
      consumePendingFirstMessage(tabId) {
        const msg = get().pendingFirstMessages[tabId];
        if (msg === undefined) return null;
        set((s) => {
          const { [tabId]: _drop, ...rest } = s.pendingFirstMessages;
          return { pendingFirstMessages: rest };
        });
        return msg;
      },
      addPin(pin) {
        set((s) => ({ pins: [...s.pins, { ...pin, id: uid() }] }));
      },
      removePin(id) {
        set((s) => ({ pins: s.pins.filter((p) => p.id !== id) }));
      },
      updatePin(id, patch) {
        set((s) => ({
          pins: s.pins.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        }));
      },
      movePin(id, direction) {
        set((s) => {
          const idx = s.pins.findIndex((p) => p.id === id);
          if (idx === -1) return s;
          const pin = s.pins[idx];
          // Only swap with the nearest pin in the same scope/group — the bar
          // renders global and workspace pins as separate runs.
          let j = idx + direction;
          while (
            j >= 0 &&
            j < s.pins.length &&
            (s.pins[j].scope !== pin.scope || s.pins[j].groupId !== pin.groupId)
          ) {
            j += direction;
          }
          if (j < 0 || j >= s.pins.length) return s;
          const pins = [...s.pins];
          [pins[idx], pins[j]] = [pins[j], pins[idx]];
          return { pins };
        });
      },
      reorderPins(orderedIds) {
        // Drag-reorder commits the new order of one scope group. Refill only
        // the array slots those pins occupy, so pins outside the group (other
        // scope / other workspaces) keep their positions.
        set((s) => {
          const idSet = new Set(orderedIds);
          const moved = orderedIds.map((id) => s.pins.find((p) => p.id === id));
          if (moved.some((p) => !p)) return s;
          let mi = 0;
          const pins = s.pins.map((p) => (idSet.has(p.id) ? moved[mi++]! : p));
          if (pins.every((p, i) => p === s.pins[i])) return s;
          return { pins };
        });
      },
      setPendingPinDraft(draft) {
        set({ pendingPinDraft: draft });
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

      setAgentState(tabId, state, reply, prompt) {
        set((s) => {
          const curState = s.agentStates[tabId];
          const curReply = s.agentReplies[tabId];
          const curPrompt = s.agentPrompts[tabId];
          const nextReply = reply ?? undefined;
          const nextPrompt = prompt ?? undefined;
          if (state === null) {
            if (curState === undefined && curReply === undefined && curPrompt === undefined)
              return s;
            const { [tabId]: _s, ...restState } = s.agentStates;
            const { [tabId]: _r, ...restReply } = s.agentReplies;
            const { [tabId]: _p, ...restPrompt } = s.agentPrompts;
            return {
              agentStates: restState,
              agentReplies: restReply,
              agentPrompts: restPrompt,
            };
          }
          const samePrompt = agentPromptsEqual(curPrompt, nextPrompt);
          if (curState === state && curReply === nextReply && samePrompt) return s;
          const agentStates =
            curState === state ? s.agentStates : { ...s.agentStates, [tabId]: state };
          let agentReplies = s.agentReplies;
          if (curReply !== nextReply) {
            if (nextReply === undefined) {
              const { [tabId]: _r, ...rest } = s.agentReplies;
              agentReplies = rest;
            } else {
              agentReplies = { ...s.agentReplies, [tabId]: nextReply };
            }
          }
          let agentPrompts = s.agentPrompts;
          if (!samePrompt) {
            if (nextPrompt === undefined) {
              const { [tabId]: _p, ...rest } = s.agentPrompts;
              agentPrompts = rest;
            } else {
              agentPrompts = { ...s.agentPrompts, [tabId]: nextPrompt };
            }
          }
          return { agentStates, agentReplies, agentPrompts };
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
        newTabMode: s.newTabMode,
        pins: s.pins,
        layoutTreeByGroup: s.layoutTreeByGroup,
      }),
      version: 2,
      // Lift any prior per-panel boolean into the new activePanelId /
      // panelFullscreen shape so users coming from older builds don't see
      // a closed panel where they last left one open.
      migrate: (persistedState: unknown, from: number) => {
        const s = (persistedState ?? {}) as Record<string, unknown>;
        if (from < 1) {
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
        }
        if (from < 2) {
          // Build a layoutTreeByGroup from the existing flat tabs[] +
          // tabOrderByGroup + activePanelId. Each group becomes a single
          // workspace leaf; the active group's tree is split-right with a
          // panel leaf if a panel was open at the time.
          const tabs = (s.tabs as Tab[]) ?? [];
          const order = (s.tabOrderByGroup as Record<string, string[]>) ?? {};
          const groups = (s.groups as Group[]) ?? [];
          const activeTabId = (s.activeTabId as string | null) ?? null;
          const activePanelId = (s.activePanelId as string | null) ?? null;
          const trees: Record<string, LayoutNode> = {};
          for (const g of groups) {
            const ids = order[g.id] ?? tabs.filter((t) => t.groupId === g.id).map((t) => t.id);
            const panes: Pane[] = ids
              .map((tid) => tabs.find((t) => t.id === tid))
              .filter((t): t is Tab => !!t)
              .map((t) => ({
                id: t.id,
                kind: (t.kind ?? 'shell') as PaneKind,
                title: t.title,
              }));
            const active =
              activeTabId && panes.some((p) => p.id === activeTabId) ? activeTabId : null;
            trees[g.id] = makeLeaf(panes, active);
          }
          if (activePanelId) {
            const activeTab = tabs.find((t) => t.id === activeTabId);
            const gid = activeTab?.groupId ?? groups[0]?.id;
            if (gid && trees[gid]) {
              const panelLeaf = makeLeaf([
                {
                  id: activePanelId,
                  kind: activePanelId as PaneKind,
                  title: panelTitle(activePanelId),
                },
              ]);
              trees[gid] = splitRight(trees[gid], panelLeaf);
            }
          }
          s.layoutTreeByGroup = trees;
        }
        return s;
      },
    },
  ),
);
