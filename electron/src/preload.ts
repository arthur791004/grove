import { contextBridge, ipcRenderer } from 'electron';

// Subscribe to browser-view events in preload (runs before the React renderer),
// otherwise a view that fails instantly (e.g. ECONNREFUSED on localhost) can
// fire `grove:browser-fail` before the renderer has attached its listener —
// the message would be lost. We buffer the last failure and replay it to late
// subscribers.
type FailInfo = { url: string; code: number; message: string };
type NavState = { canGoBack: boolean; canGoForward: boolean };
let lastFail: FailInfo | null = null;
let lastNavState: NavState = { canGoBack: false, canGoForward: false };
const failSubs = new Set<(info: FailInfo) => void>();
const navSubs = new Set<(url: string) => void>();
const navStateSubs = new Set<(state: NavState) => void>();
const loadingSubs = new Set<(loading: boolean) => void>();

ipcRenderer.on('grove:browser-fail', (_e, info: FailInfo) => {
  lastFail = info;
  for (const fn of failSubs) fn(info);
});
ipcRenderer.on('grove:browser-nav', (_e, url: string) => {
  // A successful nav supersedes any pending error for that URL.
  if (lastFail && lastFail.url === url) lastFail = null;
  for (const fn of navSubs) fn(url);
});
ipcRenderer.on('grove:browser-navstate', (_e, state: NavState) => {
  lastNavState = state;
  for (const fn of navStateSubs) fn(state);
});
ipcRenderer.on('grove:browser-loading', (_e, loading: boolean) => {
  if (loading) lastFail = null;
  for (const fn of loadingSubs) fn(loading);
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

contextBridge.exposeInMainWorld('grove', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('grove:pick-folder'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('grove:open-external', url),
  stateGet: (): Promise<string | null> => ipcRenderer.invoke('grove:state-get'),
  stateSet: (content: string): Promise<void> => ipcRenderer.invoke('grove:state-set', content),
  revealPath: (target: string): Promise<void> => ipcRenderer.invoke('grove:reveal-path', target),
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
    open: (url: string): Promise<void> => ipcRenderer.invoke('grove:browser-open', url),
    close: (): Promise<void> => ipcRenderer.invoke('grove:browser-close'),
    setBounds: (bounds: Bounds | null): Promise<void> =>
      ipcRenderer.invoke('grove:browser-set-bounds', bounds),
    navigate: (url: string): Promise<void> => ipcRenderer.invoke('grove:browser-navigate', url),
    reload: (): Promise<void> => ipcRenderer.invoke('grove:browser-reload'),
    back: (): Promise<void> => ipcRenderer.invoke('grove:browser-back'),
    forward: (): Promise<void> => ipcRenderer.invoke('grove:browser-forward'),
    onNav: (cb: (url: string) => void): (() => void) => {
      navSubs.add(cb);
      return () => {
        navSubs.delete(cb);
      };
    },
    onNavState: (cb: (state: NavState) => void): (() => void) => {
      navStateSubs.add(cb);
      // Replay the latest state so late subscribers aren't stuck disabled.
      cb(lastNavState);
      return () => {
        navStateSubs.delete(cb);
      };
    },
    onFail: (cb: (info: FailInfo) => void): (() => void) => {
      failSubs.add(cb);
      // Replay the most recent failure to late subscribers.
      if (lastFail) cb(lastFail);
      return () => {
        failSubs.delete(cb);
      };
    },
    onLoading: (cb: (loading: boolean) => void): (() => void) => {
      loadingSubs.add(cb);
      return () => {
        loadingSubs.delete(cb);
      };
    },
    clearFail: (): void => {
      lastFail = null;
    },
  },
});
