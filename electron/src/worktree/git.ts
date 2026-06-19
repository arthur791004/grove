import { spawnSync } from 'node:child_process';
import path from 'node:path';

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

export function runGit(args: string[], cwd: string, timeoutMs = 5000): RunResult {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs });
    let stderr = (r.stderr ?? '').toString();
    // A null exit status means git never exited normally — it was killed by
    // the timeout or a signal, or failed to spawn. spawnSync reports that via
    // `error`/`signal`, not stderr, so fold it in or the caller is left with
    // a useless "git exited null".
    if (!stderr.trim()) {
      if (r.error) {
        stderr =
          (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
            ? `git timed out after ${timeoutMs}ms`
            : String(r.error);
      } else if (r.signal) {
        stderr = `git killed by ${r.signal}`;
      }
    }
    return {
      ok: r.status === 0,
      stdout: (r.stdout ?? '').toString(),
      stderr,
      status: r.status,
    };
  } catch (err) {
    return { ok: false, stdout: '', stderr: String(err), status: null };
  }
}

// Worktree add/remove touch the filesystem heavily (checking out a tree,
// deleting a worktree dir that may carry a large node_modules), so they need
// a far more generous timeout than the quick metadata queries above.
const FS_HEAVY_TIMEOUT_MS = 120_000;

// Uses --git-common-dir so it returns the *main* checkout when called from
// inside a linked worktree (rather than the worktree dir itself).
export function resolveRepoRoot(cwd: string): string | null {
  const r = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!r.ok) return null;
  const commonDir = r.stdout.trim();
  if (!commonDir) return null;
  const base = path.basename(commonDir);
  return base === '.git' ? path.dirname(commonDir) : commonDir;
}

export function headSha(cwd: string): string | null {
  const r = runGit(['rev-parse', 'HEAD'], cwd);
  return r.ok ? r.stdout.trim() || null : null;
}

export function currentBranch(cwd: string): string | null {
  const r = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!r.ok) return null;
  const out = r.stdout.trim();
  return out && out !== 'HEAD' ? out : null;
}

export interface WorktreeStatus {
  hasUncommitted: boolean;
  hasUnpushed: boolean;
  unpushedCount: number;
  currentBranch: string | null;
}

export function worktreeStatus(cwd: string): WorktreeStatus {
  // `--untracked-files=no` skips noise like .DS_Store / node_modules / editor
  // swp files. Only tracked-file changes count as "dirty" for the close
  // confirm flow and the branch-cleanup decision; otherwise every fork that
  // ever ran `ls` would block its own grove/* branch deletion.
  const dirty = runGit(['status', '--porcelain', '--untracked-files=no'], cwd);
  const hasUncommitted = dirty.ok && dirty.stdout.trim().length > 0;
  const branch = currentBranch(cwd);
  let unpushedCount = 0;
  let hasUnpushed = false;
  // `git log @{u}..` errors when there's no upstream — treat as "nothing to
  // push" rather than surfacing the error.
  const log = runGit(['log', '@{u}..', '--oneline'], cwd);
  if (log.ok) {
    const lines = log.stdout.trim();
    unpushedCount = lines ? lines.split('\n').length : 0;
    hasUnpushed = unpushedCount > 0;
  }
  return { hasUncommitted, hasUnpushed, unpushedCount, currentBranch: branch };
}

export function listWorktreePaths(repoRoot: string): string[] {
  const r = runGit(['worktree', 'list', '--porcelain'], repoRoot);
  if (!r.ok) return [];
  const out: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) out.push(line.slice('worktree '.length).trim());
  }
  return out;
}

export function addWorktree(
  repoRoot: string,
  branch: string,
  worktreePath: string,
  fromSha: string,
): RunResult {
  return runGit(
    ['worktree', 'add', '-b', branch, worktreePath, fromSha],
    repoRoot,
    FS_HEAVY_TIMEOUT_MS,
  );
}

export function removeWorktree(repoRoot: string, worktreePath: string, force: boolean): RunResult {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  return runGit(args, repoRoot, FS_HEAVY_TIMEOUT_MS);
}

// Drops stale worktree admin entries (dirs that were deleted or unlinked out
// from under git). Used as part of close recovery when `worktree remove`
// rejects a path it no longer recognises as a working tree.
export function pruneWorktrees(repoRoot: string): RunResult {
  return runGit(['worktree', 'prune'], repoRoot, FS_HEAVY_TIMEOUT_MS);
}

export function listGroveBranches(repoRoot: string): string[] {
  const r = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/grove/'], repoRoot);
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function deleteBranch(repoRoot: string, branch: string): RunResult {
  return runGit(['branch', '-D', branch], repoRoot);
}
