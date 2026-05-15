import { ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addWorktree,
  deleteBranch,
  headSha,
  listGroveBranches,
  removeWorktree,
  resolveRepoRoot,
  worktreeStatus,
  type WorktreeStatus,
} from './git';
import { displayName, generateBranchName } from './name-gen';
import * as registry from './registry';

const WORKTREE_ROOT = path.join(os.homedir(), '.grove', 'worktrees');

export interface ForkRequest {
  workspaceId: string;
  sourceCwd: string;
}

export interface ForkResult {
  branch: string;
  displayName: string;
  worktreePath: string;
}

export interface CloseRequest {
  workspaceId: string;
  force?: boolean;
}

export interface StatusRequest {
  workspaceId: string;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function safeBasename(p: string): string {
  const base = path.basename(p.replace(/\/+$/, '')) || 'repo';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function registerWorktreeHandlers() {
  ipcMain.handle('workspace:fork', async (_e, req: ForkRequest): Promise<ForkResult> => {
    if (!req || typeof req.workspaceId !== 'string' || typeof req.sourceCwd !== 'string') {
      throw new Error('workspace:fork: invalid request');
    }
    const sourceCwd = expandHome(req.sourceCwd);
    const repoRoot = resolveRepoRoot(sourceCwd);
    if (!repoRoot) {
      throw new Error('Source workspace is not inside a git repository.');
    }
    const sha = headSha(sourceCwd);
    if (!sha) {
      throw new Error('Could not resolve HEAD of source workspace. Has it had any commits?');
    }

    const repoSlug = safeBasename(repoRoot);
    fs.mkdirSync(path.join(WORKTREE_ROOT, repoSlug), { recursive: true });

    // Branch-name collisions are vanishingly rare with 60 animals × 64K hex;
    // retry on the off-chance.
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const branch = generateBranchName();
      const slug = displayName(branch);
      const worktreePath = path.join(WORKTREE_ROOT, repoSlug, slug);
      const r = addWorktree(repoRoot, branch, worktreePath, sha);
      if (r.ok) {
        registry.add({
          workspaceId: req.workspaceId,
          repoRoot,
          branch,
          worktreePath,
          createdAt: Date.now(),
        });
        return { branch, displayName: slug, worktreePath };
      }
      lastErr = r.stderr.trim() || `git exited ${r.status}`;
      if (!/already exists|already used by worktree/i.test(lastErr)) break;
    }
    throw new Error(`git worktree add failed: ${lastErr}`);
  });

  ipcMain.handle(
    'workspace:close',
    async (_e, req: CloseRequest): Promise<{ removed: boolean; branchDeleted: boolean }> => {
      if (!req || typeof req.workspaceId !== 'string') {
        throw new Error('workspace:close: invalid request');
      }
      const record = registry.get(req.workspaceId);
      if (!record) return { removed: false, branchDeleted: false };
      // Close always cleans up: worktree + the grove/<animal>-<hash> branch we
      // created at fork time. The renderer is responsible for warning the user
      // when there's uncommitted work — by the time we reach here, they've
      // confirmed they're OK losing it.
      const r = removeWorktree(record.repoRoot, record.worktreePath, !!req.force);
      if (!r.ok) {
        if (!fs.existsSync(record.worktreePath)) {
          registry.remove(req.workspaceId);
          return { removed: true, branchDeleted: false };
        }
        throw new Error(
          `git worktree remove failed: ${r.stderr.trim() || `git exited ${r.status}`}`,
        );
      }
      registry.remove(req.workspaceId);
      const del = deleteBranch(record.repoRoot, record.branch);
      return { removed: true, branchDeleted: del.ok };
    },
  );

  ipcMain.handle('workspace:is-git-repo', async (_e, req: { cwd: string }): Promise<boolean> => {
    if (!req || typeof req.cwd !== 'string') return false;
    return resolveRepoRoot(expandHome(req.cwd)) !== null;
  });

  ipcMain.handle(
    'workspace:status',
    async (_e, req: StatusRequest): Promise<WorktreeStatus | null> => {
      if (!req || typeof req.workspaceId !== 'string') return null;
      const record = registry.get(req.workspaceId);
      if (!record || !fs.existsSync(record.worktreePath)) return null;
      return worktreeStatus(record.worktreePath);
    },
  );

  ipcMain.handle('workspace:list-worktrees', async () => {
    return registry.list();
  });

  ipcMain.handle(
    'workspace:list-grove-branches',
    async (_e, req: { liveWorkspaceIds?: string[]; cwds?: string[] }): Promise<OrphanBranch[]> => {
      const liveIds = new Set(Array.isArray(req?.liveWorkspaceIds) ? req.liveWorkspaceIds : []);
      const seenRoots = new Set<string>();
      for (const rec of registry.list()) seenRoots.add(rec.repoRoot);
      if (Array.isArray(req?.cwds)) {
        for (const cwd of req.cwds) {
          if (typeof cwd !== 'string' || !cwd) continue;
          const root = resolveRepoRoot(expandHome(cwd));
          if (root) seenRoots.add(root);
        }
      }
      // A registry entry whose workspaceId is no longer claimed by the renderer
      // means the user removed the workspace without going through the proper
      // close path — its worktree dir is now an orphan we own.
      const orphanWorktreesByBranch = new Map<string, string>();
      const safe = new Set<string>();
      for (const rec of registry.list()) {
        const key = `${rec.repoRoot}\0${rec.branch}`;
        if (liveIds.has(rec.workspaceId)) safe.add(key);
        else orphanWorktreesByBranch.set(key, rec.worktreePath);
      }
      const out: OrphanBranch[] = [];
      for (const repoRoot of seenRoots) {
        for (const branch of listGroveBranches(repoRoot)) {
          const key = `${repoRoot}\0${branch}`;
          if (safe.has(key)) continue;
          const worktreePath = orphanWorktreesByBranch.get(key);
          out.push(worktreePath ? { repoRoot, branch, worktreePath } : { repoRoot, branch });
        }
      }
      return out;
    },
  );

  ipcMain.handle(
    'workspace:delete-branches',
    async (
      _e,
      req: { entries: OrphanBranch[] },
    ): Promise<{ deleted: number; errors: Array<{ branch: string; message: string }> }> => {
      const errors: Array<{ branch: string; message: string }> = [];
      let deleted = 0;
      if (!req?.entries || !Array.isArray(req.entries)) return { deleted, errors };
      for (const { repoRoot, branch, worktreePath } of req.entries) {
        if (typeof repoRoot !== 'string' || typeof branch !== 'string') continue;
        if (!branch.startsWith('grove/')) continue;
        // Tear down any orphan worktree first — git refuses to delete a branch
        // that's still checked out somewhere.
        if (worktreePath) {
          removeWorktree(repoRoot, worktreePath, true);
          const rec = registry.list().find((r) => r.worktreePath === worktreePath);
          if (rec) registry.remove(rec.workspaceId);
        }
        const r = deleteBranch(repoRoot, branch);
        if (r.ok) deleted += 1;
        else errors.push({ branch, message: r.stderr.trim() || `git exited ${r.status}` });
      }
      return { deleted, errors };
    },
  );
}

export interface OrphanBranch {
  repoRoot: string;
  branch: string;
  worktreePath?: string;
}
