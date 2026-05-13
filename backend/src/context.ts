import type { FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function safeRun(cmd: string, args: string[], cwd: string): string | null {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 800 });
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

function findRepoRoot(start: string): string | null {
  let dir = start;
  while (dir && dir !== '/') {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

let cachedNode: string | null = null;
function nodeVersion(): string | null {
  if (cachedNode !== null) return cachedNode;
  cachedNode = safeRun('node', ['-v'], os.homedir());
  return cachedNode;
}

export interface ChipContext {
  cwd: string;
  shortCwd: string;
  repoRoot: string | null;
  branch: string | null;
  diff: { added: number; removed: number; files: number } | null;
  node: string | null;
}

export function getContextFor(cwd: string): ChipContext {
  const repoRoot = findRepoRoot(cwd);
  let branch: string | null = null;
  let diff: ChipContext['diff'] = null;
  if (repoRoot) {
    branch = safeRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    const shortstat = safeRun('git', ['diff', '--shortstat'], repoRoot);
    if (shortstat) {
      const filesM = shortstat.match(/(\d+) files? changed/);
      const addM = shortstat.match(/(\d+) insertions?/);
      const delM = shortstat.match(/(\d+) deletions?/);
      diff = {
        files: filesM ? parseInt(filesM[1], 10) : 0,
        added: addM ? parseInt(addM[1], 10) : 0,
        removed: delM ? parseInt(delM[1], 10) : 0,
      };
    }
  }
  return {
    cwd,
    shortCwd: shortPath(cwd),
    repoRoot: repoRoot ? shortPath(repoRoot) : null,
    branch,
    diff,
    node: nodeVersion(),
  };
}

export function registerContextRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { cwd?: string } }>('/context', async (req) => {
    const cwd = req.query.cwd || os.homedir();
    return getContextFor(cwd);
  });
}
