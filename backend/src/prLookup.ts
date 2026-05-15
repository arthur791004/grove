import { execSync, spawn } from 'node:child_process';

export interface PrInfo {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  url: string;
}

interface CacheEntry {
  ts: number;
  pr: PrInfo | null;
  inflight: boolean;
}

const TTL_MS = 60_000; // re-check at most once a minute per (repo,branch)
const cache = new Map<string, CacheEntry>();

let ghAvailable: boolean | null = null;
function hasGh(): boolean {
  if (ghAvailable !== null) return ghAvailable;
  try {
    execSync('command -v gh', { stdio: 'ignore' });
    ghAvailable = true;
  } catch {
    ghAvailable = false;
  }
  return ghAvailable;
}

function key(repoRoot: string, branch: string): string {
  return `${repoRoot}|${branch}`;
}

// Synchronous accessor: returns whatever's cached. Kicks off a background
// refresh if the entry is missing or stale. The refresh calls `onUpdate`
// when the lookup completes so the caller can re-broadcast ctx.
export function getPr(repoRoot: string, branch: string, onUpdate: () => void): PrInfo | null {
  if (!hasGh()) return null;
  const k = key(repoRoot, branch);
  const entry = cache.get(k);
  const fresh = entry && Date.now() - entry.ts < TTL_MS;
  if (!fresh && !(entry && entry.inflight)) {
    refresh(repoRoot, branch, onUpdate);
  }
  return entry ? entry.pr : null;
}

function refresh(repoRoot: string, branch: string, onUpdate: () => void): void {
  const k = key(repoRoot, branch);
  const prior = cache.get(k);
  cache.set(k, { ts: prior?.ts ?? 0, pr: prior?.pr ?? null, inflight: true });
  const proc = spawn('gh', ['pr', 'view', branch, '--json', 'number,title,state,isDraft,url'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  proc.stdout.on('data', (b) => {
    out += b.toString();
  });
  proc.on('error', () => {
    cache.set(k, { ts: Date.now(), pr: null, inflight: false });
  });
  proc.on('close', (code) => {
    let pr: PrInfo | null = null;
    if (code === 0 && out.trim()) {
      try {
        const j = JSON.parse(out);
        if (j && typeof j.number === 'number') {
          pr = {
            number: j.number,
            title: j.title || '',
            state: (j.state || 'OPEN') as PrInfo['state'],
            draft: !!j.isDraft,
            url: j.url || '',
          };
        }
      } catch {}
    }
    const before = cache.get(k);
    cache.set(k, { ts: Date.now(), pr, inflight: false });
    // Only nudge listeners when the PR snapshot actually changed.
    if (!before || JSON.stringify(before.pr) !== JSON.stringify(pr)) {
      try {
        onUpdate();
      } catch {}
    }
  });
}
