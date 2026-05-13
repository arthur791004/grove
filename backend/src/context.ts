import type { FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { sessionCwd, sessionNodeVersion, sessionEnv } from './sessions.js';
import { findRepoRoot, safeRun, shortPath } from './gitUtil.js';

const NODE_CACHE_TTL = 5000;
const nodeCache = new Map<string, { v: string | null; ts: number }>();

function nodeVersion(cwd: string): string | null {
  const key = cwd;
  const now = Date.now();
  const hit = nodeCache.get(key);
  if (hit && now - hit.ts < NODE_CACHE_TTL) return hit.v;
  // Use the user's interactive shell so nvm / fnm / asdf / volta initializers run
  // and the active node version is reflected (incl. .nvmrc in cwd).
  const shell = process.env.SHELL || '/bin/zsh';
  const r = spawnSync(shell, ['-i', '-c', 'node -v 2>/dev/null'], {
    cwd,
    encoding: 'utf8',
    timeout: 1500,
  });
  const v = r.status === 0 ? (r.stdout.trim() || null) : null;
  nodeCache.set(key, { v, ts: now });
  return v;
}

export interface ChipContext {
  cwd: string;
  shortCwd: string;
  repoRoot: string | null;
  branch: string | null;
  diff: { added: number; removed: number; files: number } | null;
  node: string | null;
  env: Record<string, string>;
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
    node: nodeVersion(cwd),
    env: {},
  };
}

export function registerContextRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { cwd?: string; tabId?: string } }>('/context', async (req) => {
    const tabId = req.query.tabId;
    const sessCwd = tabId ? sessionCwd(tabId) : null;
    const sessNode = tabId ? sessionNodeVersion(tabId) : null;
    const env = tabId ? sessionEnv(tabId) : {};
    const cwd = sessCwd || req.query.cwd || os.homedir();
    const ctx = getContextFor(cwd);
    if (sessNode) ctx.node = sessNode;
    if (env.branch) ctx.branch = env.branch;
    ctx.env = env;
    return { ...ctx, cwdReady: sessCwd !== null };
  });
}
