import { contextBridge, ipcRenderer } from 'electron';

// Subscribe to frame events in preload (runs before the React renderer),
// otherwise an iframe that fails instantly (e.g. ECONNREFUSED on localhost)
// can fire `did-fail-load` before the renderer has had a chance to attach
// its listener — the message would be lost.
type FailInfo = { url: string; code: number; message: string };
let lastFail: FailInfo | null = null;
const failSubs = new Set<(info: FailInfo) => void>();
const navSubs = new Set<(url: string) => void>();
ipcRenderer.on('grove:frame-fail', (_e, info: FailInfo) => {
  lastFail = info;
  for (const fn of failSubs) fn(info);
});
ipcRenderer.on('grove:frame-nav', (_e, url: string) => {
  // A successful nav supersedes any pending error for that URL.
  if (lastFail && lastFail.url === url) lastFail = null;
  for (const fn of navSubs) fn(url);
});

contextBridge.exposeInMainWorld('grove', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('grove:pick-folder'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('grove:open-external', url),
  onFrameNav: (cb: (url: string) => void): (() => void) => {
    navSubs.add(cb);
    return () => { navSubs.delete(cb); };
  },
  onFrameFail: (cb: (info: FailInfo) => void): (() => void) => {
    failSubs.add(cb);
    // Replay the most recent fail to late subscribers (fixes the race where
    // the iframe fails before React mounts the listener).
    if (lastFail) cb(lastFail);
    return () => { failSubs.delete(cb); };
  },
  clearFrameFail: (): void => { lastFail = null; },
});
