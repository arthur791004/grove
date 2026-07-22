import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { API_BASE } from './api';
import type { LayoutNode, LeafNode, Pane, PaneKind, SplitNode } from './layout/types';
import {
  addPaneToLeaf,
  findLeaf,
  findLeafContaining,
  getAllLeaves,
  getAllPanes,
  hasPaneOfKind,
  makeLeaf,
  mapLeaves,
  removePane,
  reorderLeafPanes,
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
export type TabPosition = 'sidebar' | 'top';

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
  // 'branch' diffs against the base branch's merge-base (branch commits +
  // uncommitted work); 'working' diffs against HEAD (uncommitted only).
  diffMode: DiffMode;
  fileBrowserListOpen: boolean;
  fileBrowserRequest: {
    path: string;
    kind: 'file' | 'dir';
    nonce: number;
    line?: number;
    col?: number;
    claudeEditRange?: { fromLine: number; toLine: number };
  } | null;
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
  // Where tab strips render: 'sidebar' = today's per-workspace list under the
  // sidebar's workspace label (including diff/files/browser panes); 'top' =
  // browser-style TabBar above each leaf, sidebar shows workspaces only.
  tabPosition: TabPosition;
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
  // Modal open state. Lives in the store (rather than per-component useState)
  // so the Electron overlay renderer — a separate BrowserWindow that hosts
  // these modals above the WebContentsView — can subscribe to it via the
  // state bridge at the bottom of this file. In web mode the same state
  // drives the modals rendered directly in the main renderer.
  paletteOpen: boolean;
  settingsOpen: boolean;
  // Renderer-side custom dropdown menu. The main renderer requests via
  // showPopupMenu() (helper below); the overlay renderer renders the
  // styled menu and writes the picked id back via popupMenuResult. In
  // web mode the same state drives a menu rendered in the only renderer.
  popupMenu: {
    id: string;
    items: Array<{ id: string; label: string; hint?: string; enabled?: boolean }>;
    anchor: { x: number; y: number };
  } | null;
  popupMenuResult: { id: string; pickedId: string | null } | null;
  // Header URL omnibox. Opened from the browser pane's URL bar with a
  // snapshot of the live services + workspace history; rendered above
  // the WebContentsView in the overlay window so the page stays visible
  // underneath. The picked URL (or null on dismiss) flows back via
  // headerOmniboxResult.
  headerOmnibox: {
    id: string;
    anchor: { x: number; y: number; width: number };
    initialValue: string;
    services: Array<{
      port: number;
      host: string;
      pid: number;
      cmd: string;
      cwd: string | null;
      url: string;
    }> | null;
    history: Array<{ url: string; visitedAt: number }>;
  } | null;
  headerOmniboxResult: { id: string; pickedUrl: string | null } | null;
  // System CPU / memory pushed by the backend over /system-stats. Read
  // only by the sidebar footer gauges via a tight selector; broader
  // components do not subscribe, so the 2s tick doesn't fan out.
  systemStats: {
    cpu: number;
    memUsed: number;
    memTotal: number;
    ts: number;
  } | null;
  // Per-workspace pane tree. One LayoutNode per group; mutated alongside the
  // legacy tabs[] / activePanelId fields. LayoutHost reads from here so the
  // user can drag dividers, split panels off, and (slice 5) drag tabs
  // between leaves. The legacy fields stay in sync for unmigrated consumers
  // (Sidebar, AgentsView, useTabContext, …).
  layoutTreeByGroup: Record<string, LayoutNode>;
  // Per-pane state for the panel kinds. Lets a workspace hold multiple Diff
  // / Files / Browser panes that each remember their own selection, search,
  // URL, etc. Keyed by pane.id (now a uid for newly-added panel panes;
  // historical 'diff'/'files'/'browser' ids still work as keys for trees
  // persisted before this change — see v3 migration).
  paneState: Record<string, PaneState>;
  // First message to send into a new Claude tab once its TUI is ready (state
  // first transitions to 'blocked' or 'working' with no pending message).
  // Keyed by tab id; consumed once on send.
  pendingFirstMessages: Record<string, string>;
}

// Per-pane state for panel kinds. Each instance of a Diff / Files / Browser
// pane gets its own slice — opening a second Diff in the same workspace
// keeps independent selection and search state.
export type DiffMode = 'working' | 'branch';

export interface DiffPaneState {
  fileListOpen?: boolean;
  selectedFile?: string | null;
}
export interface FilesPaneState {
  listOpen?: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
  currentPath?: string | null;
}
export interface BrowserPaneState {
  listOpen?: boolean;
  url?: string | null;
}
export type PaneState =
  | ({ kind: 'diff' } & DiffPaneState)
  | ({ kind: 'files' } & FilesPaneState)
  | ({ kind: 'browser' } & BrowserPaneState);

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
  newTab(
    groupId?: string,
    title?: string,
    opts?: {
      mode?: NewTabMode;
      // When set, append the new pane as a tab inside this existing leaf
      // rather than creating a new sibling top-level entry. The top-mode
      // TabBar `+` uses this so the gesture matches "new tab in this leaf".
      inLeafId?: string;
    },
  ): string;
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
  setDiffMode(mode: DiffMode): void;
  toggleFileBrowserList(): void;
  openFileInBrowser(
    path: string,
    kind?: 'file' | 'dir',
    opts?: { line?: number; col?: number; claudeEditRange?: { fromLine: number; toLine: number } },
  ): void;
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
  setTabPosition(v: TabPosition): void;
  consumeClaudeBootstrap(tabId: string): boolean;
  setTabClaudeSession(tabId: string, sessionId: string): void;
  setSessionChoice(v: SessionChoice | null): void;
  openAgentsView(): void;
  closeAgentsView(): void;
  toggleAgentsView(): void;
  setPaletteOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  setPopupMenu(req: State['popupMenu']): void;
  setPopupMenuResult(r: State['popupMenuResult']): void;
  setHeaderOmnibox(req: State['headerOmnibox']): void;
  setHeaderOmniboxResult(r: State['headerOmniboxResult']): void;
  setSystemStats(s: State['systemStats']): void;
  // Layout-tree mutations (slice 4+). Resize is wired in slice 3 so the
  // user-dragged divider persists across renders.
  resizeLayoutSplit(groupId: string, splitId: string, sizes: number[]): void;
  // Swap two direct siblings in their containing split. Used by the leaf
  // drag handle in PaneOverlay so the user can reorder visible sub-panes.
  swapSiblingsInTree(groupId: string, nodeIdA: string, nodeIdB: string): void;
  // Move a direct child of root from one index to another. Used by sidebar
  // dnd to reorder top-level "tabs" (whether they're single leaves or
  // sub-split groups).
  moveTopLevelInTree(groupId: string, fromNodeId: string, toNodeId: string): void;
  // Shallow-merge per-pane state. Initializes the slice on first write if
  // it doesn't exist yet — caller supplies `kind` once on the first write
  // (omitted on subsequent writes, copied from existing slice).
  setPaneState(paneId: string, patch: Partial<PaneState> & { kind?: PaneState['kind'] }): void;
  splitLeafInTree(
    groupId: string,
    leafId: string,
    dir: 'h' | 'v',
    pane: Pane,
    after: boolean,
  ): void;
  addPaneToLeafInTree(groupId: string, leafId: string, pane: Pane): void;
  // Create a new terminal-backed tab AND place it as its own leaf splitting
  // off `leafId`. Wraps the tab-creation half of `newTab` so the new pane
  // lands in a sibling leaf instead of the workspace leaf.
  splitLeafWithNewTab(groupId: string, leafId: string, dir: 'h' | 'v', mode: NewTabMode): string;
  reorderLeafPanesInTree(groupId: string, leafId: string, paneIds: string[]): void;
  // Move a pane from whatever leaf it currently lives in to `destLeafId` at
  // `destIndex`. No-op if source leaf is the destination — within-leaf
  // reorder uses reorderLeafPanesInTree.
  movePaneAcrossLeaves(
    groupId: string,
    paneId: string,
    destLeafId: string,
    destIndex: number,
  ): void;
  // Pop an existing pane out of its current leaf and into a fresh sibling
  // leaf. No-op if the pane is already alone in its leaf (nothing would
  // change). Used by the sidebar's "Open in split" affordance.
  splitOffPaneInTree(groupId: string, paneId: string, dir: 'h' | 'v', after: boolean): void;
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

function leafExistsInTree(tree: LayoutNode, leafId: string): boolean {
  if (tree.type === 'leaf') return tree.id === leafId;
  return tree.children.some((c) => leafExistsInTree(c, leafId));
}

// Find the top-level entry (direct child of root, or root itself if it's
// a leaf) that contains the given pane. Used by close handlers to keep
// focus inside the same "tab" when one of its sub-panes is removed.
function topLevelContaining(tree: LayoutNode, paneId: string): LayoutNode | null {
  if (tree.type === 'leaf') {
    return tree.panes.some((p) => p.id === paneId) ? tree : null;
  }
  for (const child of tree.children) {
    const found = (function walk(n: LayoutNode): boolean {
      if (n.type === 'leaf') return n.panes.some((p) => p.id === paneId);
      return n.children.some(walk);
    })(child);
    if (found) return child;
  }
  return null;
}

// Pick the pane that should receive focus after `paneId` is closed.
//
// Walks the tree in three priority bands so the focus shift always lands as
// close as possible to where the user was working:
//   1. **Same leaf** — if the closing pane has a tab sibling in its own
//      leaf, focus that (prefers the pane after, falls back to the one
//      before).
//   2. **Adjacent leaf within the same top-level tab** — when the leaf
//      collapses entirely, focus the nearest sibling leaf in the same
//      sub-split (i.e., still in the user's current "tab" on the main
//      screen).
//   3. **Previous tab** — if the whole top-level tab collapses, focus the
//      previous top-level entry; if the closed entry was first, fall back
//      to the next one.
function focusAfterClose(tree: LayoutNode, paneId: string): string | null {
  // 1) Same-leaf sibling.
  const leaf = (function findLeaf(node: LayoutNode): LeafNode | null {
    if (node.type === 'leaf') return node.panes.some((p) => p.id === paneId) ? node : null;
    for (const c of node.children) {
      const r = findLeaf(c);
      if (r) return r;
    }
    return null;
  })(tree);
  if (leaf) {
    const idx = leaf.panes.findIndex((p) => p.id === paneId);
    if (idx >= 0 && leaf.panes.length > 1) {
      return leaf.panes[idx + 1]?.id ?? leaf.panes[idx - 1]?.id ?? null;
    }
  }
  // 2) Adjacent leaf inside the same top-level tab.
  const top = topLevelContaining(tree, paneId);
  if (top && leaf) {
    const nearbyInTop = nearestSiblingLeafFocus(top, leaf.id);
    if (nearbyInTop) return nearbyInTop;
  }
  // 3) Adjacent top-level tab — focus its previously-active pane, not its
  // first pane, so the user lands on what was visible there before.
  const children: LayoutNode[] = tree.type === 'split' ? tree.children : [tree];
  const idx = top ? children.indexOf(top) : -1;
  if (idx < 0) return null;
  const fallback = children[idx - 1] ?? children[idx + 1];
  if (!fallback) return null;
  return activePaneIdIn(fallback);
}

// Resolve the "currently active" pane id within a sub-tree by walking leaves
// and respecting each leaf's `activePaneId`. Picks the first leaf encountered
// in tree order — good enough for the focus-restore fallback.
function activePaneIdIn(node: LayoutNode): string | null {
  if (node.type === 'leaf') {
    return node.activePaneId ?? node.panes[0]?.id ?? null;
  }
  for (const c of node.children) {
    const r = activePaneIdIn(c);
    if (r) return r;
  }
  return null;
}

// Within a top-level entry, find the active pane of the leaf nearest to the
// soon-to-be-removed leaf. Walks the sub-tree to locate siblings of `leafId`
// at the closest split level.
function nearestSiblingLeafFocus(top: LayoutNode, leafId: string): string | null {
  if (top.type === 'leaf') return null;
  for (const child of top.children) {
    const found = (function walk(n: LayoutNode): boolean {
      if (n.type === 'leaf') return n.id === leafId;
      return n.children.some(walk);
    })(child);
    if (found) {
      const idx = top.children.indexOf(child);
      const sibling = top.children[idx + 1] ?? top.children[idx - 1];
      if (sibling) return activePaneIdIn(sibling);
      const deeper = nearestSiblingLeafFocus(child, leafId);
      if (deeper) return deeper;
      return null;
    }
  }
  return null;
}

function panelTitle(kind: string): string {
  if (kind === 'diff') return 'Diff';
  if (kind === 'files') return 'Files';
  if (kind === 'browser') return 'Browser';
  return kind;
}

// Mint a fresh panel pane plus its initial state slice. Each instance gets a
// new uid so the same workspace can hold multiple Diff / Files / Browser
// panes that don't share state. Returns the seed state the caller should
// merge into store.paneState along with creating the pane.
export function makePanelPane(kind: 'diff' | 'files' | 'browser'): {
  pane: Pane;
  state: PaneState;
} {
  const id = uid();
  const pane: Pane = { id, kind, title: panelTitle(kind) };
  let state: PaneState;
  if (kind === 'diff') state = { kind, fileListOpen: true, selectedFile: null };
  else if (kind === 'files')
    state = {
      kind,
      listOpen: true,
      searchOpen: false,
      searchQuery: '',
      currentPath: null,
    };
  else state = { kind, listOpen: true, url: null };
  return { pane, state };
}

function withPanelOpen(
  s: State,
  panelKind: 'diff' | 'files' | 'browser',
): Pick<State, 'activePanelId' | 'layoutTreeByGroup' | 'paneState'> {
  const gid = activeGroupId(s);
  if (!gid)
    return {
      activePanelId: s.activePanelId,
      layoutTreeByGroup: s.layoutTreeByGroup,
      paneState: s.paneState,
    };
  const tree = s.layoutTreeByGroup[gid] ?? makeLeaf([]);
  // Each call mints a fresh instance — no more "already open → focus"; the
  // user can have multiple of any kind.
  const { pane, state } = makePanelPane(panelKind);
  const panelLeaf = makeLeaf([pane]);
  const nextTree = splitRight(tree, panelLeaf);
  return {
    activePanelId: pane.id,
    layoutTreeByGroup: { ...s.layoutTreeByGroup, [gid]: nextTree },
    paneState: { ...s.paneState, [pane.id]: state },
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

// Focus the most-recently-added pane of this kind in the active workspace's
// tree; create one only if there isn't any. Used by callers that mean
// "show me a Files panel" rather than "spawn another Files panel" — e.g.,
// openFileInBrowser routing a file from a terminal block to the panel.
function withPanelFocusOrOpen(
  s: State,
  panelKind: 'diff' | 'files' | 'browser',
): Pick<State, 'activePanelId' | 'layoutTreeByGroup' | 'paneState'> {
  const gid = activeGroupId(s);
  if (!gid)
    return {
      activePanelId: s.activePanelId,
      layoutTreeByGroup: s.layoutTreeByGroup,
      paneState: s.paneState,
    };
  const tree = s.layoutTreeByGroup[gid];
  if (!tree) return withPanelOpen(s, panelKind);
  const panes = getAllPanes(tree);
  const existing = [...panes].reverse().find((p) => p.kind === panelKind);
  if (!existing) return withPanelOpen(s, panelKind);
  const nextTree = setActivePane(tree, existing.id);
  return {
    activePanelId: existing.id,
    layoutTreeByGroup:
      nextTree === tree ? s.layoutTreeByGroup : { ...s.layoutTreeByGroup, [gid]: nextTree },
    paneState: s.paneState,
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
      diffMode: 'branch',
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
      tabPosition: 'sidebar',
      claudeBootstrapTabs: {},
      pins: DEFAULT_PINS,
      pendingPinDraft: null,
      sessionChoice: null,
      agentsViewOpen: false,
      paletteOpen: false,
      settingsOpen: false,
      popupMenu: null,
      popupMenuResult: null,
      headerOmnibox: null,
      headerOmniboxResult: null,
      systemStats: null,
      pendingFirstMessages: {},
      layoutTreeByGroup: { default: makeLeaf([]) },
      paneState: {},

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
          groups: s.groups.map((g) => (g.id === groupId ? { ...g, forkContextConsumed: true } : g)),
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
          let nextTree: LayoutNode;
          if (opts?.inLeafId && leafExistsInTree(tree, opts.inLeafId)) {
            // Append to the given leaf as a new tab. Used by the top-mode
            // TabBar `+` so the new tab lands inside the same leaf, not as
            // a new top-level sibling.
            nextTree = addPaneToLeaf(tree, opts.inLeafId, pane) as LayoutNode;
          } else if (tree.type === 'leaf' && tree.panes.length === 0) {
            // Bootstrap from an empty tree.
            nextTree = makeLeaf([pane]);
          } else {
            // Default (also: caller passed a stale inLeafId): new top-level
            // tab as a sibling leaf at root, so the tab is always visible
            // somewhere instead of becoming an orphan in `tabs[]`.
            nextTree = splitRight(tree, makeLeaf([pane]), 50);
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
          // Focus picking: prefer a sibling in the same top-level tab; if
          // the whole tab is collapsing, jump to the previous tab instead.
          let nextActive = s.activeTabId;
          if (s.activeTabId === id) {
            const treeBefore = s.layoutTreeByGroup[tab.groupId];
            const next = treeBefore ? focusAfterClose(treeBefore, id) : null;
            nextActive = next ?? orderForGroup[0] ?? remaining[0]?.id ?? null;
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
          let nextTree = tree ? removePane(tree, id) : null;
          // Update the sibling leaf's activePaneId so it renders the
          // surviving pane (rather than the stale closed one).
          if (nextTree && nextActive) {
            nextTree = setActivePane(nextTree, nextActive);
          }
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
          // Tabs only ever represent shell/claude panes — focusing one means
          // no panel is the current focus. Drop the legacy global flag so
          // sidebar panel rows don't keep highlighting the last-opened panel.
          const base = {
            activeTabId: id,
            layoutTreeByGroup,
            activePanelId: id ? null : s.activePanelId,
          };
          if (!id || !s.unreadTabs[id]) return base;
          const { [id]: _, ...rest } = s.unreadTabs;
          return { ...base, unreadTabs: rest };
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
          const update: Partial<State> = {
            tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, groupId: targetGroupId } : t)),
            tabOrderByGroup: {
              ...s.tabOrderByGroup,
              [oldGroup]: oldOrder,
              [targetGroupId]: targetOrder,
            },
          };
          // Move the pane across layout trees too. The sidebar renders rows
          // from the *tree*, not from tabOrderByGroup — so a cross-workspace
          // move that only touched the tab bookkeeping would leave the tab
          // invisible in the target (its pane never arrived) and orphaned in
          // the source tree. Relocate the pane node so both views agree.
          if (oldGroup !== targetGroupId) {
            const sourceTree = s.layoutTreeByGroup[oldGroup];
            const targetTree = s.layoutTreeByGroup[targetGroupId];
            const sourceLeaf = sourceTree ? findLeafContaining(sourceTree, tabId) : null;
            const pane = sourceLeaf?.panes.find((p) => p.id === tabId) ?? null;
            if (sourceTree && targetTree && pane) {
              // removePane collapses an emptied leaf/split; fall back to an
              // empty leaf so the source workspace never goes tree-less.
              const trimmedSource = removePane(sourceTree, tabId) ?? makeLeaf([]);
              // Land it as its own top-level leaf (its own sidebar row).
              const newLeaf = makeLeaf([pane]);
              const nextTarget =
                targetTree.type === 'leaf' && targetTree.panes.length === 0
                  ? newLeaf
                  : splitRight(targetTree, newLeaf, 50);
              update.layoutTreeByGroup = {
                ...s.layoutTreeByGroup,
                [oldGroup]: trimmedSource,
                [targetGroupId]: nextTarget,
              };
            }
          }
          return update;
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
      openPanel(kind) {
        set((s) => withPanelOpen(s, kind as 'diff' | 'files' | 'browser'));
      },
      closePanel() {
        set((s) => withPanelClosed(s));
      },
      togglePanel(kind) {
        // With multiple instances per kind allowed, "toggle" loses precision —
        // we focus an existing pane of the kind if any, otherwise spawn a new
        // one. (Closing happens via the per-pane X.)
        set((s) => withPanelFocusOrOpen(s, kind as 'diff' | 'files' | 'browser'));
      },
      togglePanelFullscreen(id) {
        set((s) => ({
          panelFullscreen: { ...s.panelFullscreen, [id]: !s.panelFullscreen[id] },
        }));
      },

      toggleDiffFileList() {
        set((s) => ({ diffFileListOpen: !s.diffFileListOpen }));
      },
      setDiffMode(mode) {
        set({ diffMode: mode });
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

      openFileInBrowser(path, kind = 'file', opts) {
        // Route through focus-or-open: reuse the workspace's existing Files
        // pane if one exists rather than spawning a fresh pane every time a
        // terminal block routes a file here.
        set((s) => ({
          ...withPanelFocusOrOpen(s, 'files'),
          fileBrowserRequest: {
            path,
            kind,
            nonce: Date.now(),
            line: opts?.line,
            col: opts?.col,
            claudeEditRange: opts?.claudeEditRange,
          },
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
      setTabPosition(v) {
        set({ tabPosition: v });
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
      setPaletteOpen(open) {
        set({ paletteOpen: open });
      },
      setSettingsOpen(open) {
        set({ settingsOpen: open });
      },
      setPopupMenu(req) {
        set({ popupMenu: req });
      },
      setPopupMenuResult(r) {
        set({ popupMenuResult: r });
      },
      setHeaderOmnibox(req) {
        set({ headerOmnibox: req });
      },
      setHeaderOmniboxResult(r) {
        set({ headerOmniboxResult: r });
      },
      setSystemStats(s) {
        set({ systemStats: s });
      },
      setPaneState(paneId, patch) {
        set((s) => {
          const prev = s.paneState[paneId];
          const kind = patch.kind ?? prev?.kind;
          if (!kind) return s;
          const next = { ...(prev ?? {}), ...patch, kind } as PaneState;
          return { paneState: { ...s.paneState, [paneId]: next } };
        });
      },
      moveTopLevelInTree(groupId, fromNodeId, toNodeId) {
        if (fromNodeId === toNodeId) return;
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree || tree.type !== 'split') return s;
          const fromIdx = tree.children.findIndex((c) => c.id === fromNodeId);
          const toIdx = tree.children.findIndex((c) => c.id === toNodeId);
          if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return s;
          const next = [...tree.children];
          const [moved] = next.splice(fromIdx, 1);
          next.splice(toIdx, 0, moved);
          return {
            layoutTreeByGroup: {
              ...s.layoutTreeByGroup,
              [groupId]: { ...tree, children: next },
            },
          };
        });
      },
      swapSiblingsInTree(groupId, nodeIdA, nodeIdB) {
        // Swap two nodes regardless of where they sit in the tree. Each
        // node takes the other's exact slot — parent splits keep their
        // shape, no collapse, no reflow other than what the swap implies.
        if (nodeIdA === nodeIdB) return;
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          // Locate both nodes (anywhere in the tree) and grab their values.
          let nodeA: LayoutNode | null = null;
          let nodeB: LayoutNode | null = null;
          (function find(n: LayoutNode) {
            if (n.id === nodeIdA) nodeA = n;
            if (n.id === nodeIdB) nodeB = n;
            if (n.type === 'split') n.children.forEach(find);
          })(tree);
          if (!nodeA || !nodeB) return s;
          // Refuse to swap when one is an ancestor of the other — would put
          // the ancestor inside itself and corrupt the tree.
          const isAncestor = (ancestor: LayoutNode, descendantId: string): boolean => {
            if (ancestor.type === 'leaf') return false;
            return ancestor.children.some(
              (c) => c.id === descendantId || isAncestor(c, descendantId),
            );
          };
          if (isAncestor(nodeA, nodeIdB) || isAncestor(nodeB, nodeIdA)) return s;
          // Rewrite the tree, replacing each by the other.
          function swap(n: LayoutNode): LayoutNode {
            if (n.id === nodeIdA) return nodeB!;
            if (n.id === nodeIdB) return nodeA!;
            if (n.type === 'leaf') return n;
            return { ...n, children: n.children.map(swap) };
          }
          const nextTree = swap(tree);
          return {
            layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: nextTree },
          };
        });
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
          let tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          // Multi-pane leaf: extract the active pane into its own leaf
          // first so the split is about THAT pane's space, not the whole
          // leaf. Otherwise the new panel ends up as a sibling of the
          // entire leaf, which the sidebar then merges into a single
          // group row that visually hides the original sibling tabs. See
          // splitLeafWithNewTab for the same rationale.
          const sourceLeaf = findLeaf(tree, leafId);
          if (sourceLeaf && sourceLeaf.panes.length > 1) {
            const activePaneId = sourceLeaf.activePaneId ?? sourceLeaf.panes[0]?.id;
            const activePane = activePaneId
              ? sourceLeaf.panes.find((p) => p.id === activePaneId)
              : null;
            if (activePane) {
              const trimmed =
                mapLeaves(tree, (l) => {
                  if (l.id !== sourceLeaf.id) return l;
                  const remaining = l.panes.filter((p) => p.id !== activePaneId);
                  const stillActive = remaining[0]?.id ?? null;
                  return { ...l, panes: remaining, activePaneId: stillActive };
                }) ?? tree;
              const extractedLeaf = makeLeaf([activePane]);
              const withExtracted = splitLeafOp(trimmed, sourceLeaf.id, dir, extractedLeaf, true);
              const newLeaf = makeLeaf([pane]);
              const next = splitLeafOp(withExtracted, extractedLeaf.id, dir, newLeaf, after);
              return { layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: next } };
            }
          }
          // If the entire root is the leaf being split, wrap it in a single-
          // child "tabs" split first. Otherwise splitting a root-leaf gives
          // a split with two top-level children, which the layout treats as
          // two separate tabs instead of side-by-side panes inside one tab.
          if (tree.type === 'leaf' && tree.id === leafId) {
            tree = {
              type: 'split',
              id: `tabs-${uid()}`,
              role: 'tabs',
              dir: 'h',
              sizes: [100],
              children: [tree],
            };
          }
          const newLeaf = makeLeaf([pane]);
          const next = splitLeafOp(tree, leafId, dir, newLeaf, after);
          return { layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: next } };
        });
      },
      addPaneToLeafInTree(groupId, leafId, pane) {
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          const next = addPaneToLeaf(tree, leafId, pane);
          return { layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: next } };
        });
      },
      splitLeafWithNewTab(groupId, leafId, dir, mode) {
        const id = uid();
        const tab: Tab = {
          id,
          title: mode,
          color: pickRandomColor(),
          groupId,
          kind: mode === 'claude' ? 'claude' : 'shell',
        };
        const pane: Pane = { id, kind: tab.kind as PaneKind, title: tab.title };
        set((s) => {
          let tree = s.layoutTreeByGroup[groupId] ?? makeLeaf([]);
          // Multi-pane leaf case: the split should be ABOUT the active pane,
          // not the whole leaf. Otherwise we end up with a sub-split that
          // wraps every co-resident tab into one merged sidebar group, which
          // visually loses the sibling tabs (they're no longer top-level
          // entries — they're stuck inside the new sub-split). Fix: pull
          // the active pane out into its own leaf first; the siblings stay
          // behind in the original leaf and remain a separate top-level
          // tab. Then split the extracted leaf with the new pane.
          const sourceLeaf = findLeaf(tree, leafId);
          if (sourceLeaf && sourceLeaf.panes.length > 1) {
            const activePaneId = sourceLeaf.activePaneId ?? sourceLeaf.panes[0]?.id;
            const activePane = activePaneId
              ? sourceLeaf.panes.find((p) => p.id === activePaneId)
              : null;
            if (activePane) {
              const trimmed =
                mapLeaves(tree, (l) => {
                  if (l.id !== sourceLeaf.id) return l;
                  const remaining = l.panes.filter((p) => p.id !== activePaneId);
                  const stillActive = remaining[0]?.id ?? null;
                  return { ...l, panes: remaining, activePaneId: stillActive };
                }) ?? tree;
              const extractedLeaf = makeLeaf([activePane]);
              // Step 1: insert the extracted leaf as a sibling of the
              // trimmed source — same direction as the requested split so
              // the placement matches the user's intent.
              const withExtracted = splitLeafOp(trimmed, sourceLeaf.id, dir, extractedLeaf, true);
              // Step 2: split the extracted leaf with the new pane.
              const nextTree = splitLeafOp(
                withExtracted,
                extractedLeaf.id,
                dir,
                makeLeaf([pane]),
                true,
              );
              const next: Partial<State> = {
                tabs: [...s.tabs, tab],
                tabOrderByGroup: {
                  ...s.tabOrderByGroup,
                  [groupId]: [...(s.tabOrderByGroup[groupId] ?? []), id],
                },
                layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: nextTree },
                activeTabId: id,
              };
              if (mode === 'claude') {
                next.claudeBootstrapTabs = { ...s.claudeBootstrapTabs, [id]: true };
              }
              return next;
            }
          }
          // Single-pane leaf (or fallback): wrap a bare-leaf root in a tabs
          // container so closing one side later doesn't collapse the split,
          // then split.
          if (tree.type === 'leaf' && tree.id === leafId) {
            tree = {
              type: 'split',
              id: `tabs-${uid()}`,
              role: 'tabs',
              dir: 'h',
              sizes: [100],
              children: [tree],
            };
          }
          const nextTree = splitLeafOp(tree, leafId, dir, makeLeaf([pane]), true);
          const next: Partial<State> = {
            tabs: [...s.tabs, tab],
            tabOrderByGroup: {
              ...s.tabOrderByGroup,
              [groupId]: [...(s.tabOrderByGroup[groupId] ?? []), id],
            },
            layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: nextTree },
            activeTabId: id,
          };
          if (mode === 'claude') {
            next.claudeBootstrapTabs = { ...s.claudeBootstrapTabs, [id]: true };
          }
          return next;
        });
        return id;
      },
      reorderLeafPanesInTree(groupId, leafId, paneIds) {
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          const next = reorderLeafPanes(tree, leafId, paneIds);
          if (next === tree) return s;
          return { layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: next } };
        });
      },
      splitOffPaneInTree(groupId, paneId, dir, after) {
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          const sourceLeaf = findLeafContaining(tree, paneId);
          if (!sourceLeaf || sourceLeaf.panes.length <= 1) return s;
          const pane = sourceLeaf.panes.find((p) => p.id === paneId);
          if (!pane) return s;
          // Remove the pane first so the source leaf has the right shape
          // when we re-find it for the split target.
          const trimmed = mapLeaves(tree, (leaf) => {
            if (leaf.id !== sourceLeaf.id) return leaf;
            const remaining = leaf.panes.filter((p) => p.id !== paneId);
            const stillActive =
              leaf.activePaneId === paneId ? (remaining[0]?.id ?? null) : leaf.activePaneId;
            return { ...leaf, panes: remaining, activePaneId: stillActive };
          });
          if (!trimmed) return s;
          const newLeaf = makeLeaf([pane]);
          const next = splitLeafOp(trimmed, sourceLeaf.id, dir, newLeaf, after);
          return { layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: next } };
        });
      },
      movePaneAcrossLeaves(groupId, paneId, destLeafId, destIndex) {
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          const sourceLeaf = findLeafContaining(tree, paneId);
          if (!sourceLeaf || sourceLeaf.id === destLeafId) return s;
          const pane = sourceLeaf.panes.find((p) => p.id === paneId);
          if (!pane) return s;
          // Remove from source; if the source leaf empties, mapLeaves
          // collapses the parent split.
          const afterRemove = removePane(tree, paneId);
          if (!afterRemove) {
            // Source was the only leaf and it'd vanish — refuse the move
            // so the workspace never ends up tree-less.
            return s;
          }
          const inserted = mapLeaves(afterRemove, (leaf) => {
            if (leaf.id !== destLeafId) return leaf;
            const panes = [...leaf.panes];
            const i = Math.max(0, Math.min(destIndex, panes.length));
            panes.splice(i, 0, pane);
            return { ...leaf, panes, activePaneId: paneId };
          });
          if (!inserted) return s;
          return {
            layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: inserted },
          };
        });
      },
      removePaneFromTree(groupId, paneId) {
        set((s) => {
          const tree = s.layoutTreeByGroup[groupId];
          if (!tree) return s;
          // Decide where focus should land before mutating the tree, so
          // the helper can see the full context.
          const fallback = focusAfterClose(tree, paneId);
          let nextTree = removePane(tree, paneId) ?? makeLeaf([]);
          if (fallback) {
            nextTree = setActivePane(nextTree, fallback);
          }
          const update: Partial<State> = {
            layoutTreeByGroup: { ...s.layoutTreeByGroup, [groupId]: nextTree },
          };
          const fallbackPane = fallback
            ? (function walk(n: LayoutNode): Pane | null {
                if (n.type === 'leaf') return n.panes.find((p) => p.id === fallback) ?? null;
                for (const c of n.children) {
                  const r = walk(c);
                  if (r) return r;
                }
                return null;
              })(nextTree)
            : null;
          if (s.activePanelId === paneId) {
            update.activePanelId = null;
            if (fallbackPane) {
              if (
                fallbackPane.kind === 'diff' ||
                fallbackPane.kind === 'files' ||
                fallbackPane.kind === 'browser'
              ) {
                update.activePanelId = fallbackPane.id;
              } else {
                update.activeTabId = fallbackPane.id;
              }
            }
          } else if (s.activeTabId === paneId && fallbackPane) {
            update.activeTabId = fallbackPane.id;
          }
          return update;
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
        diffMode: s.diffMode,
        fileBrowserListOpen: s.fileBrowserListOpen,
        browserPanelListOpen: s.browserPanelListOpen,
        browserPanelUrl: s.browserPanelUrl,
        browserHistory: s.browserHistory,
        monoFontFamily: s.monoFontFamily,
        monoFontSize: s.monoFontSize,
        newTabMode: s.newTabMode,
        tabPosition: s.tabPosition,
        pins: s.pins,
        layoutTreeByGroup: s.layoutTreeByGroup,
        paneState: s.paneState,
      }),
      version: 4,
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
        if (from < 3) {
          // Seed per-pane state from the legacy global panel fields. Existing
          // diff/files/browser panes were created with their `kind` as `id`,
          // so we key paneState by the same id; new panes will use uids and
          // initialize their own slice when added.
          const trees = (s.layoutTreeByGroup as Record<string, unknown> | undefined) ?? {};
          const paneState: Record<string, unknown> = {};
          for (const tree of Object.values(trees)) {
            const walk = (n: any): void => {
              if (!n) return;
              if (n.type === 'leaf') {
                for (const p of n.panes ?? []) {
                  if (p.kind === 'diff' && !paneState[p.id]) {
                    paneState[p.id] = {
                      kind: 'diff',
                      fileListOpen: s.diffFileListOpen !== false,
                      selectedFile: null,
                    };
                  } else if (p.kind === 'files' && !paneState[p.id]) {
                    paneState[p.id] = {
                      kind: 'files',
                      listOpen: s.fileBrowserListOpen !== false,
                      searchOpen: false,
                      searchQuery: '',
                      currentPath: null,
                    };
                  } else if (p.kind === 'browser' && !paneState[p.id]) {
                    paneState[p.id] = {
                      kind: 'browser',
                      listOpen: s.browserPanelListOpen !== false,
                      url: (s.browserPanelUrl as string | null | undefined) ?? null,
                    };
                  }
                }
              } else {
                for (const child of n.children ?? []) walk(child);
              }
            };
            walk(tree);
          }
          s.paneState = paneState;
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
        if (from < 4) {
          // Backfill the new SplitNode.role field on persisted trees by
          // detecting the legacy `tabs-*` id prefix. Pre-v4 the convention
          // was id-prefix-only; v4 promotes it to a typed field so id
          // collisions can't accidentally affect collapse behavior.
          const trees = (s.layoutTreeByGroup as Record<string, LayoutNode> | undefined) ?? {};
          const tagTabs = (node: LayoutNode): LayoutNode => {
            if (node.type === 'leaf') return node;
            const tagged: SplitNode = {
              ...node,
              role: node.id.startsWith('tabs-') ? 'tabs' : node.role,
              children: node.children.map(tagTabs),
            };
            return tagged;
          };
          const upgraded: Record<string, LayoutNode> = {};
          for (const [gid, t] of Object.entries(trees)) upgraded[gid] = tagTabs(t);
          s.layoutTreeByGroup = upgraded;
        }
        return s;
      },
    },
  ),
);

// --- Cross-renderer state bridge ------------------------------------------
// In Electron, modals (CommandPalette, SettingsModal, SessionChoiceDialog)
// live in a separate overlay BrowserWindow that draws above the
// WebContentsView. Both renderers share this useStore module but each has
// its own zustand instance; the bridge below keeps them in lockstep by
// broadcasting every local setState (data fields only — actions stay
// per-renderer) to main, which forwards to the other window. Incoming
// updates are applied under a `syncing` flag so they don't echo back.
//
// In web mode (no window.grove), the bridge is a no-op — there's no
// overlay window, and the modals render in the only renderer there is.
if (typeof window !== 'undefined' && window.grove?.overlay) {
  const overlay = window.grove.overlay;

  const stripFns = (state: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k in state) {
      if (typeof state[k] !== 'function') out[k] = state[k];
    }
    return out;
  };

  // Suppress only the IMMEDIATE echo of a just-applied remote state. We
  // can't use a `syncing` boolean wrapped around setState: if a local
  // subscriber reacts to the remote update by triggering another
  // setState (e.g. showPopupMenu's subscriber calling setPopupMenu(null)
  // after receiving a popupMenuResult), that nested setState ALSO fires
  // with syncing=true and the bridge silently drops it — the divergent
  // local change never makes it back to the other renderer. Instead we
  // record the exact state we just applied; the next bridge-subscribe
  // tick that matches it (the echo from applyRemote's own setState) is
  // skipped, and any further state changes (the nested local ones) go
  // through normally.
  let lastApplied: string | null = null;

  const applyRemote = (remote: unknown) => {
    if (!remote || typeof remote !== 'object') return;
    const current = useStore.getState() as unknown as Record<string, unknown>;
    const merged: Record<string, unknown> = {};
    for (const k in remote as Record<string, unknown>) {
      if (typeof current[k] !== 'function') {
        merged[k] = (remote as Record<string, unknown>)[k];
      }
    }
    // Snapshot of what the store WILL look like for stripFns-visible
    // keys after this remote is merged in. Subscribe compares against
    // this and skips the matching echo.
    const projected: Record<string, unknown> = stripFns(current);
    for (const k in merged) projected[k] = merged[k];
    lastApplied = JSON.stringify(projected);
    useStore.setState(merged as never, false);
  };

  overlay.onState(applyRemote);

  // Coalesce multiple setStates within a frame into a single broadcast —
  // setState fires often during pty replay, drag, etc.
  let pendingBroadcast: Record<string, unknown> | null = null;
  let scheduled = false;
  useStore.subscribe((state) => {
    const stripped = stripFns(state as unknown as Record<string, unknown>);
    if (lastApplied !== null && JSON.stringify(stripped) === lastApplied) {
      // Exactly the state we just received — don't echo it back. Clear
      // the marker so a later identical local change (unlikely but
      // possible) DOES broadcast.
      lastApplied = null;
      return;
    }
    lastApplied = null;
    pendingBroadcast = stripped;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (pendingBroadcast) {
        overlay.sendState(pendingBroadcast);
        pendingBroadcast = null;
      }
    });
  });

  if (overlay.isOverlay) {
    // Overlay: hydrate from main on startup. Main has loaded from persist
    // already and is the canonical source; we want to mirror it before
    // any modal renders.
    void overlay.requestState().then((s) => {
      if (s) applyRemote(s);
    });
  }
}
