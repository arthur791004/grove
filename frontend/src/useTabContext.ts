import { useEffect, useState } from 'react';
import { API_BASE } from './api';

export interface TabContext {
  shortCwd: string;
  branch: string | null;
  node: string | null;
  diff: { added: number; removed: number; files: number } | null;
  env: Record<string, string>;
}

const cache = new Map<string, TabContext>();

function sameCtx(a: TabContext | null | undefined, b: TabContext): boolean {
  if (!a) return false;
  if (a.shortCwd !== b.shortCwd || a.branch !== b.branch || a.node !== b.node) return false;
  const ad = a.diff, bd = b.diff;
  if (ad !== bd) {
    if (!ad || !bd) return false;
    if (ad.added !== bd.added || ad.removed !== bd.removed || ad.files !== bd.files) return false;
  }
  const aks = Object.keys(a.env), bks = Object.keys(b.env);
  if (aks.length !== bks.length) return false;
  for (const k of aks) if (a.env[k] !== b.env[k]) return false;
  return true;
}

export function useTabContext(tabId: string, refreshKey: number = 0, pollMs = 1500): TabContext | null {
  const [ctx, setCtx] = useState<TabContext | null>(cache.get(tabId) ?? null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const ctxRes = await fetch(`${API_BASE}/context?tabId=${encodeURIComponent(tabId)}`);
        const data = await ctxRes.json();
        if (cancelled) return;
        const next: TabContext = {
          shortCwd: data.shortCwd,
          branch: data.branch,
          node: data.node,
          diff: data.diff,
          env: data.env ?? {},
        };
        const prev = cache.get(tabId);
        if (sameCtx(prev, next)) return;
        cache.set(tabId, next);
        setCtx(next);
      } catch {}
    }
    refresh();
    const id = setInterval(refresh, pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [tabId, refreshKey, pollMs]);

  return ctx;
}
