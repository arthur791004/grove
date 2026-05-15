import { useEffect, useState } from 'react';
import { API_BASE } from './api';

export interface TabContext {
  cwd: string;
  shortCwd: string;
  repoRoot: string | null;
  branch: string | null;
  node: string | null;
  diff: { added: number; removed: number; files: number } | null;
  pr: {
    number: number;
    title: string;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    draft: boolean;
    url: string;
  } | null;
  env: Record<string, string>;
  cwdReady: boolean;
}

const cache = new Map<string, TabContext>();
const listeners = new Map<string, Set<(c: TabContext) => void>>();
const oneShotFetched = new Set<string>();
// Global subscribers receive every tab's ctx update. Used by the sidebar's
// workspace branch hook to avoid polling — any tab in a workspace that lands
// a ctx with matching repoRoot is the authoritative source of the workspace's
// current branch.
const globalListeners = new Set<(tabId: string, ctx: TabContext) => void>();

export function subscribeAllTabContexts(fn: (tabId: string, ctx: TabContext) => void): () => void {
  globalListeners.add(fn);
  return () => {
    globalListeners.delete(fn);
  };
}

export function getCachedTabContext(tabId: string): TabContext | null {
  return cache.get(tabId) ?? null;
}

function sameCtx(a: TabContext, b: TabContext): boolean {
  if (a.shortCwd !== b.shortCwd || a.branch !== b.branch || a.node !== b.node) return false;
  if (a.repoRoot !== b.repoRoot) return false;
  if (a.cwdReady !== b.cwdReady) return false;
  const ad = a.diff,
    bd = b.diff;
  if (ad !== bd) {
    if (!ad || !bd) return false;
    if (ad.added !== bd.added || ad.removed !== bd.removed || ad.files !== bd.files) return false;
  }
  const ap = a.pr,
    bp = b.pr;
  if (ap !== bp) {
    if (!ap || !bp) return false;
    if (ap.number !== bp.number || ap.state !== bp.state || ap.draft !== bp.draft) return false;
  }
  const aks = Object.keys(a.env),
    bks = Object.keys(b.env);
  if (aks.length !== bks.length) return false;
  for (const k of aks) if (a.env[k] !== b.env[k]) return false;
  return true;
}

function toCtx(data: Partial<TabContext> & Record<string, unknown>): TabContext {
  return {
    cwd: typeof data.cwd === 'string' ? data.cwd : '',
    shortCwd: typeof data.shortCwd === 'string' ? data.shortCwd : '',
    repoRoot: typeof data.repoRoot === 'string' ? data.repoRoot : null,
    branch: typeof data.branch === 'string' ? data.branch : null,
    node: typeof data.node === 'string' ? data.node : null,
    diff: (data.diff as TabContext['diff']) ?? null,
    pr: (data.pr as TabContext['pr']) ?? null,
    env: (data.env as TabContext['env']) ?? {},
    cwdReady: Boolean(data.cwdReady),
  };
}

/** Backend-pushed ctx (from the per-tab WebSocket) flows in through here. */
export function setTabContext(
  tabId: string,
  data: Partial<TabContext> & Record<string, unknown>,
): void {
  const next = toCtx(data);
  const prev = cache.get(tabId);
  if (prev && sameCtx(prev, next)) return;
  cache.set(tabId, next);
  const subs = listeners.get(tabId);
  if (subs) for (const fn of subs) fn(next);
  for (const fn of globalListeners) fn(tabId, next);
}

export function useTabContext(
  tabId: string,
  _refreshKey: number = 0,
  _pollMs = 0,
  enabled = true,
): TabContext | null {
  const [ctx, setCtx] = useState<TabContext | null>(cache.get(tabId) ?? null);

  useEffect(() => {
    if (!tabId) return;
    let subs = listeners.get(tabId);
    if (!subs) {
      subs = new Set();
      listeners.set(tabId, subs);
    }
    const fn = (c: TabContext) => setCtx(c);
    subs.add(fn);
    const cached = cache.get(tabId);
    if (cached) setCtx(cached);

    // One-shot HTTP fetch on first mount per tab, so chips show something
    // before the backend has had a chance to push (or in case the WS isn't
    // connected yet). After that the WS push is the source of truth.
    if (enabled && !oneShotFetched.has(tabId)) {
      oneShotFetched.add(tabId);
      fetch(`${API_BASE}/context?tabId=${encodeURIComponent(tabId)}`)
        .then((r) => r.json())
        .then((data) => setTabContext(tabId, data))
        .catch(() => {
          oneShotFetched.delete(tabId);
        });
    }

    return () => {
      subs!.delete(fn);
    };
  }, [tabId, enabled]);

  return ctx;
}
