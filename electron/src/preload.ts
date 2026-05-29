import { contextBridge, ipcRenderer } from 'electron';

// Subscribe to browser-view events in preload (runs before the React renderer),
// otherwise a view that fails instantly (e.g. ECONNREFUSED on localhost) can
// fire `grove:browser-fail` before the renderer has attached its listener —
// the message would be lost. We buffer the last failure and replay it to late
// subscribers.
// Each browser event now carries a paneId so the renderer can route it to
// the right BrowserPanel instance. Buffer last-seen-per-pane state so a
// late-mounting panel still sees its own current navigation status.
type FailInfo = { paneId: string; url: string; code: number; message: string };
type NavState = { paneId: string; canGoBack: boolean; canGoForward: boolean };
type NavEvent = { paneId: string; url: string };
type LoadingEvent = { paneId: string; loading: boolean };
const lastFailByPane = new Map<string, FailInfo>();
const lastNavStateByPane = new Map<string, NavState>();
const failSubs = new Set<(info: FailInfo) => void>();
const navSubs = new Set<(ev: NavEvent) => void>();
const navStateSubs = new Set<(state: NavState) => void>();
const loadingSubs = new Set<(ev: LoadingEvent) => void>();

ipcRenderer.on('grove:browser-fail', (_e, info: FailInfo) => {
  lastFailByPane.set(info.paneId, info);
  for (const fn of failSubs) fn(info);
});
ipcRenderer.on('grove:browser-nav', (_e, ev: NavEvent) => {
  const cached = lastFailByPane.get(ev.paneId);
  if (cached && cached.url === ev.url) lastFailByPane.delete(ev.paneId);
  for (const fn of navSubs) fn(ev);
});
ipcRenderer.on('grove:browser-navstate', (_e, state: NavState) => {
  lastNavStateByPane.set(state.paneId, state);
  for (const fn of navStateSubs) fn(state);
});
ipcRenderer.on('grove:browser-loading', (_e, ev: LoadingEvent) => {
  if (ev.loading) lastFailByPane.delete(ev.paneId);
  for (const fn of loadingSubs) fn(ev);
});

// A click on a blocked-Claude notification: `send` set = an action button
// (route the answer to the tab's pty), `send` null = the body (just open it).
type NotificationResponse = { tabId: string; send: string | null };
const notifRespondSubs = new Set<(r: NotificationResponse) => void>();
ipcRenderer.on('grove:notification-respond', (_e, r: NotificationResponse) => {
  for (const fn of notifRespondSubs) fn(r);
});

type Bounds = { x: number; y: number; width: number; height: number; zoom?: number };

import type {
  CloseRequest,
  ForkRequest,
  ForkResult,
  OrphanBranch,
  StatusRequest,
} from './worktree/ipc';
import type { WorktreeStatus } from './worktree/git';
import type { RemoteStatus } from './remote';

contextBridge.exposeInMainWorld('grove', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('grove:pick-folder'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('grove:open-external', url),
  stateGet: (): Promise<string | null> => ipcRenderer.invoke('grove:state-get'),
  stateSet: (content: string): Promise<void> => ipcRenderer.invoke('grove:state-set', content),
  revealPath: (target: string): Promise<void> => ipcRenderer.invoke('grove:reveal-path', target),
  notifyAttention: (): Promise<void> => ipcRenderer.invoke('grove:notify-attention'),
  notifyBlocked: (notice: {
    tabId: string;
    title: string;
    workspace: string;
    question: string;
    choices: Array<{ label: string; send: string }>;
  }): Promise<void> => ipcRenderer.invoke('grove:notify-blocked', notice),
  onNotificationRespond: (cb: (r: NotificationResponse) => void): (() => void) => {
    notifRespondSubs.add(cb);
    return () => {
      notifRespondSubs.delete(cb);
    };
  },
  workspace: {
    fork: (req: ForkRequest): Promise<ForkResult> => ipcRenderer.invoke('workspace:fork', req),
    close: (req: CloseRequest): Promise<{ removed: boolean; branchDeleted: boolean }> =>
      ipcRenderer.invoke('workspace:close', req),
    status: (req: StatusRequest): Promise<WorktreeStatus | null> =>
      ipcRenderer.invoke('workspace:status', req),
    isGitRepo: (req: { cwd: string }): Promise<boolean> =>
      ipcRenderer.invoke('workspace:is-git-repo', req),
    listGroveBranches: (req: { cwds?: string[] }): Promise<OrphanBranch[]> =>
      ipcRenderer.invoke('workspace:list-grove-branches', req),
    deleteBranches: (req: {
      entries: OrphanBranch[];
    }): Promise<{ deleted: number; errors: Array<{ branch: string; message: string }> }> =>
      ipcRenderer.invoke('workspace:delete-branches', req),
  },
  browser: {
    open: (paneId: string, url: string): Promise<void> =>
      ipcRenderer.invoke('grove:browser-open', paneId, url),
    close: (paneId: string): Promise<void> => ipcRenderer.invoke('grove:browser-close', paneId),
    destroy: (paneId: string): Promise<void> =>
      ipcRenderer.invoke('grove:browser-destroy', paneId),
    setBounds: (paneId: string, bounds: Bounds | null): Promise<void> =>
      ipcRenderer.invoke('grove:browser-set-bounds', paneId, bounds),
    setOverlayHidden: (hidden: boolean): Promise<void> =>
      ipcRenderer.invoke('grove:browser-set-overlay-hidden', hidden),
    navigate: (paneId: string, url: string): Promise<void> =>
      ipcRenderer.invoke('grove:browser-navigate', paneId, url),
    reload: (paneId: string): Promise<void> => ipcRenderer.invoke('grove:browser-reload', paneId),
    back: (paneId: string): Promise<void> => ipcRenderer.invoke('grove:browser-back', paneId),
    forward: (paneId: string): Promise<void> =>
      ipcRenderer.invoke('grove:browser-forward', paneId),
    onNav: (cb: (ev: NavEvent) => void): (() => void) => {
      navSubs.add(cb);
      return () => {
        navSubs.delete(cb);
      };
    },
    onNavState: (cb: (state: NavState) => void): (() => void) => {
      navStateSubs.add(cb);
      // Replay any cached state for any pane so a late subscriber gets the
      // current values immediately.
      for (const s of lastNavStateByPane.values()) cb(s);
      return () => {
        navStateSubs.delete(cb);
      };
    },
    onFail: (cb: (info: FailInfo) => void): (() => void) => {
      failSubs.add(cb);
      for (const info of lastFailByPane.values()) cb(info);
      return () => {
        failSubs.delete(cb);
      };
    },
    onLoading: (cb: (ev: LoadingEvent) => void): (() => void) => {
      loadingSubs.add(cb);
      return () => {
        loadingSubs.delete(cb);
      };
    },
    clearFail: (paneId: string): void => {
      lastFailByPane.delete(paneId);
    },
  },
  mcp: {
    writePlaywrightConfig: (tabId: string): Promise<string | null> =>
      ipcRenderer.invoke('mcp:writePlaywrightConfig', tabId),
    deleteConfig: (tabId: string): Promise<void> => ipcRenderer.invoke('mcp:deleteConfig', tabId),
  },
  remote: {
    status: (): Promise<RemoteStatus> => ipcRenderer.invoke('grove:remote-status'),
    setEnabled: (enabled: boolean): Promise<RemoteStatus> =>
      ipcRenderer.invoke('grove:remote-set', enabled),
  },
});
