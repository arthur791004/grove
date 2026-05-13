import { useEffect, useState } from 'react';

export interface TabContext {
  shortCwd: string;
  branch: string | null;
  node: string | null;
  diff: { added: number; removed: number; files: number } | null;
}

const cache = new Map<string, TabContext>();

function sameCtx(a: TabContext | null | undefined, b: TabContext): boolean {
  if (!a) return false;
  if (a.shortCwd !== b.shortCwd || a.branch !== b.branch || a.node !== b.node) return false;
  const ad = a.diff, bd = b.diff;
  if (ad === bd) return true;
  if (!ad || !bd) return false;
  return ad.added === bd.added && ad.removed === bd.removed && ad.files === bd.files;
}

export function useTabContext(tabId: string, refreshKey: number = 0, pollMs = 1500): TabContext | null {
  const [ctx, setCtx] = useState<TabContext | null>(cache.get(tabId) ?? null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const cwdRes = await fetch(`http://127.0.0.1:4317/session/${tabId}/cwd`);
        const { cwd } = await cwdRes.json();
        const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
        const ctxRes = await fetch(`http://127.0.0.1:4317/context${params}`);
        const data = await ctxRes.json();
        if (cancelled) return;
        const next: TabContext = {
          shortCwd: data.shortCwd,
          branch: data.branch,
          node: data.node,
          diff: data.diff,
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
