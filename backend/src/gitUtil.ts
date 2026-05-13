import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

export function findRepoRoot(start: string): string | null {
  let dir = start;
  while (dir && dir !== '/') {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function safeRun(cmd: string, args: string[], cwd: string, timeout = 1500): string | null {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout });
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}
