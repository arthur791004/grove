// Branch popover endpoints: list local branches and run pull / switch /
// delete actions for a given workspace cwd. Used by the hover popover on
// the branch chip in the ChipStrip — the heavier list / mutate operations
// don't belong in the per-tab context fetch.

import type { FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import { findRepoRoot, safeRun } from './gitUtil.js';

export interface BranchInfo {
  name: string;
  current: boolean;
  ahead: number;
  behind: number;
  upstream: string | null;
}

function runGit(cwd: string, args: string[], timeout = 8000): { ok: boolean; out: string; err: string } {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout });
    return {
      ok: r.status === 0,
      out: (r.stdout ?? '').trim(),
      err: (r.stderr ?? '').trim(),
    };
  } catch (e) {
    return { ok: false, out: '', err: (e as Error).message };
  }
}

function listLocalBranches(repoRoot: string): BranchInfo[] {
  // %(HEAD) is "*" for the current branch; %(refname:short) is the name;
  // %(upstream:short) the tracking branch; %(upstream:trackshort) yields
  // a compact ahead/behind code that we then resolve to numbers via
  // for-each-ref-friendly format chars.
  const fmt = '%(HEAD)|%(refname:short)|%(upstream:short)';
  const r = runGit(repoRoot, [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=${fmt}`,
    'refs/heads',
  ]);
  if (!r.ok) return [];
  const lines = r.out.split('\n').filter(Boolean);
  const result: BranchInfo[] = [];
  for (const line of lines) {
    const [head, name, upstream] = line.split('|');
    if (!name) continue;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = safeRun(
        'git',
        ['rev-list', '--left-right', '--count', `${upstream}...${name}`],
        repoRoot,
      );
      if (counts) {
        const m = counts.match(/^(\d+)\s+(\d+)$/);
        if (m) {
          behind = parseInt(m[1], 10);
          ahead = parseInt(m[2], 10);
        }
      }
    }
    result.push({
      name,
      current: head?.trim() === '*',
      ahead,
      behind,
      upstream: upstream || null,
    });
  }
  return result;
}

export function registerBranchRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { cwd?: string } }>('/git/branches', async (req, reply) => {
    const cwd = req.query.cwd;
    if (!cwd) return reply.code(400).send({ error: 'cwd required' });
    const repoRoot = findRepoRoot(cwd);
    if (!repoRoot) return reply.code(404).send({ error: 'not a git repo' });
    return { branches: listLocalBranches(repoRoot), repoRoot };
  });

  app.post<{ Body: { cwd?: string; action?: string; branch?: string } }>(
    '/git/branch-action',
    async (req, reply) => {
      const { cwd, action, branch } = req.body ?? {};
      if (!cwd || !action) return reply.code(400).send({ error: 'cwd and action required' });
      const repoRoot = findRepoRoot(cwd);
      if (!repoRoot) return reply.code(404).send({ error: 'not a git repo' });

      if (action === 'pull') {
        // Fetch + pull the current branch only — multi-branch fast-forward
        // is rarely what the user wants from a one-click affordance.
        const r = runGit(repoRoot, ['pull', '--ff-only'], 30000);
        if (!r.ok) return reply.code(400).send({ error: r.err || 'pull failed' });
        return { ok: true, out: r.out };
      }
      if (action === 'switch') {
        if (!branch) return reply.code(400).send({ error: 'branch required' });
        const r = runGit(repoRoot, ['switch', branch], 15000);
        if (!r.ok) return reply.code(400).send({ error: r.err || 'switch failed' });
        return { ok: true };
      }
      if (action === 'delete') {
        if (!branch) return reply.code(400).send({ error: 'branch required' });
        // -d refuses unmerged branches by default; surface that error so
        // the UI can prompt for a force-delete if needed (future work).
        const r = runGit(repoRoot, ['branch', '-d', branch], 8000);
        if (!r.ok) return reply.code(400).send({ error: r.err || 'delete failed' });
        return { ok: true };
      }
      return reply.code(400).send({ error: `unknown action ${action}` });
    },
  );
}
