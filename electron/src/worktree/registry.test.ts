import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test gets a fresh registry file under a fresh tmpdir, set via env BEFORE
// the module is imported so its module-scoped REGISTRY_FILE picks it up.
let tmpDir: string;

async function freshRegistry() {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-reg-'));
  process.env.GROVE_WORKTREE_REGISTRY = path.join(tmpDir, 'worktrees.json');
  return await import('./registry');
}

afterEach(() => {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
  delete process.env.GROVE_WORKTREE_REGISTRY;
});

describe('registry add/get/remove/list', () => {
  it('round-trips a record through the on-disk file', async () => {
    const reg = await freshRegistry();
    const wtPath = fs.mkdtempSync(path.join(tmpDir, 'wt-'));
    // The record's path must exist on disk for selfHeal to keep it, and git
    // must list it. Set up a real (tiny) repo + worktree so the heal passes.
    const repoRoot = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    execSync('git init -q && git commit --allow-empty -m init -q', { cwd: repoRoot });
    fs.rmdirSync(wtPath);
    execSync(`git worktree add -b grove/otter-test "${wtPath}" HEAD -q`, { cwd: repoRoot });

    reg.add({
      workspaceId: 'w1',
      repoRoot,
      branch: 'grove/otter-test',
      worktreePath: wtPath,
      createdAt: 1,
    });

    expect(reg.get('w1')?.branch).toBe('grove/otter-test');
    expect(reg.list().map((r) => r.workspaceId)).toEqual(['w1']);

    // Reload to confirm it persisted to disk.
    reg._resetForTests();
    expect(reg.get('w1')?.branch).toBe('grove/otter-test');

    reg.remove('w1');
    expect(reg.get('w1')).toBeNull();
    expect(reg.list()).toEqual([]);
  });

  it('self-heals records whose worktree directory has been deleted', async () => {
    const reg = await freshRegistry();
    fs.writeFileSync(
      process.env.GROVE_WORKTREE_REGISTRY!,
      JSON.stringify([
        {
          workspaceId: 'ghost',
          repoRoot: '/nope',
          branch: 'grove/x',
          worktreePath: '/nope/x',
          createdAt: 1,
        },
      ]),
    );
    // First load drops the stale record and rewrites the file.
    expect(reg.list()).toEqual([]);
    const onDisk = JSON.parse(fs.readFileSync(process.env.GROVE_WORKTREE_REGISTRY!, 'utf8'));
    expect(onDisk).toEqual([]);
  });

  it('returns null and empty list when the file is missing', async () => {
    const reg = await freshRegistry();
    expect(reg.get('anything')).toBeNull();
    expect(reg.list()).toEqual([]);
  });
});
