import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listWorktreePaths } from './git';
import { atomicWriteFile } from '../atomicWrite';

export interface WorktreeRecord {
  workspaceId: string;
  repoRoot: string;
  branch: string;
  worktreePath: string;
  createdAt: number;
}

// Path override is for tests; production reads the home-dir path.
const REGISTRY_FILE = process.env.GROVE_WORKTREE_REGISTRY ?? path.join(os.homedir(), '.grove', 'worktrees.json');

let records: WorktreeRecord[] | null = null;

// Test-only: drop the in-memory cache so the next load() reads fresh.
export function _resetForTests(): void {
  records = null;
}

function persist() {
  atomicWriteFile(REGISTRY_FILE, JSON.stringify(records ?? [], null, 2));
}

// Drop records git no longer knows about (user removed the worktree outside
// Grove, rm -rf'd the directory, etc.) so the registry doesn't accumulate
// phantoms.
// `git worktree list` resolves symlinks (e.g. /var → /private/var on macOS),
// so registry paths and git's listing only match after both go through
// realpath.
function safeRealpath(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

function selfHeal(rs: WorktreeRecord[]): WorktreeRecord[] {
  const knownByRepo = new Map<string, Set<string>>();
  const kept: WorktreeRecord[] = [];
  for (const r of rs) {
    const real = safeRealpath(r.worktreePath);
    if (!real) continue;
    let known = knownByRepo.get(r.repoRoot);
    if (!known) {
      known = new Set(
        listWorktreePaths(r.repoRoot).map((p) => safeRealpath(p) ?? p),
      );
      knownByRepo.set(r.repoRoot, known);
    }
    if (!known.has(real)) continue;
    kept.push(r);
  }
  return kept;
}

export function load(): WorktreeRecord[] {
  if (records) return records;
  let raw: WorktreeRecord[] = [];
  try {
    const text = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) raw = parsed.filter((r) =>
      r && typeof r.workspaceId === 'string' && typeof r.worktreePath === 'string',
    );
  } catch { /* missing or malformed — start empty */ }
  const healed = selfHeal(raw);
  records = healed;
  if (healed.length !== raw.length) persist();
  return records;
}

export function add(record: WorktreeRecord): void {
  const list = load();
  list.push(record);
  persist();
}

export function remove(workspaceId: string): void {
  const list = load();
  const idx = list.findIndex((r) => r.workspaceId === workspaceId);
  if (idx < 0) return;
  list.splice(idx, 1);
  persist();
}

export function get(workspaceId: string): WorktreeRecord | null {
  return load().find((r) => r.workspaceId === workspaceId) ?? null;
}

export function list(): WorktreeRecord[] {
  return load().slice();
}
