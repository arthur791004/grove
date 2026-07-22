import type { FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { sessionCwd } from './sessions.js';
import { expandHome, findRepoRoot, safeRun } from './gitUtil.js';

export type DiffMode = 'working' | 'branch';

const FULL_FILE_CONTEXT = 99999;
const DEFAULT_FILE_CONTEXT = FULL_FILE_CONTEXT;

interface DiffFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'unknown';
  oldPath?: string;
  added: number;
  removed: number;
  patch: string;
  binary: boolean;
}

function parseDiff(raw: string): DiffFile[] {
  if (!raw) return [];
  const files: DiffFile[] = [];
  const blocks = raw.split(/^diff --git /m).slice(1);
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0] ?? '';
    const m = header.match(/a\/(.+?) b\/(.+)$/);
    const oldPath = m?.[1];
    const newPath = m?.[2] ?? oldPath ?? '';
    let status: DiffFile['status'] = 'modified';
    let added = 0;
    let removed = 0;
    let binary = false;
    const patchLines: string[] = [];
    let inHunk = false;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('new file mode')) status = 'added';
      else if (l.startsWith('deleted file mode')) status = 'deleted';
      else if (l.startsWith('rename from')) status = 'renamed';
      else if (l.startsWith('Binary files')) {
        binary = true;
      } else if (l.startsWith('@@ ')) {
        inHunk = true;
        patchLines.push(l);
      } else if (inHunk) {
        patchLines.push(l);
        if (l.startsWith('+') && !l.startsWith('+++')) added++;
        else if (l.startsWith('-') && !l.startsWith('---')) removed++;
      }
    }
    files.push({
      path: newPath,
      oldPath: status === 'renamed' && oldPath !== newPath ? oldPath : undefined,
      status,
      added,
      removed,
      binary,
      patch: patchLines.join('\n'),
    });
  }
  return files;
}

export interface DiffResponse {
  repoRoot: string | null;
  branch: string | null;
  // In 'branch' mode, the base branch the diff is computed against (e.g.
  // 'main'). null in 'working' mode, or when no base branch could be found.
  base: string | null;
  mode: DiffMode;
  files: DiffFile[];
  total: { added: number; removed: number; files: number };
}

// The default branch of the repo, best-effort: origin's HEAD symbolic ref
// first (survives non-standard default names), then common local fallbacks.
function detectBaseBranch(repoRoot: string): string | null {
  const originHead = safeRun(
    'git',
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    repoRoot,
  );
  if (originHead) {
    const name = originHead.replace(/^origin\//, '');
    if (name) return name;
  }
  for (const cand of ['main', 'master', 'develop']) {
    if (safeRun('git', ['rev-parse', '--verify', '--quiet', cand], repoRoot)) return cand;
  }
  return null;
}

// Resolve the ref to diff the working tree against. 'working' mode diffs
// against HEAD (uncommitted changes only). 'branch' mode diffs against the
// merge-base with the base branch, so the result covers every commit made on
// this branch *plus* any uncommitted work. Returns diffBase='HEAD' whenever a
// base branch or merge-base can't be resolved, degrading to working-tree.
function resolveDiffBase(
  repoRoot: string,
  mode: DiffMode,
  branch: string | null,
): { base: string | null; diffBase: string } {
  if (mode !== 'branch') return { base: null, diffBase: 'HEAD' };
  const base = detectBaseBranch(repoRoot);
  // On the base branch itself there's nothing to compare to — behave like
  // working-tree mode and drop the (misleading) base label.
  if (!base || base === branch) return { base: null, diffBase: 'HEAD' };
  const mergeBase = safeRun('git', ['merge-base', base, 'HEAD'], repoRoot);
  return { base, diffBase: mergeBase ?? 'HEAD' };
}

function runGitDiff(repoRoot: string, base: string, extraArgs: string[] = []): string {
  try {
    const r = spawnSync(
      'git',
      [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        base,
        ...extraArgs,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 4000, maxBuffer: 16 * 1024 * 1024 },
    );
    if (r.status === 0 || r.status === 1) return r.stdout;
  } catch {}
  return '';
}

function resolveCwd(reqCwd: string | undefined, tabId: string | undefined): string {
  const sessCwd = tabId ? sessionCwd(tabId) : null;
  return sessCwd || reqCwd || os.homedir();
}

export function getDiffFor(cwdRaw: string, mode: DiffMode = 'branch'): DiffResponse {
  const cwd = expandHome(cwdRaw);
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    return {
      repoRoot: null,
      branch: null,
      base: null,
      mode,
      files: [],
      total: { added: 0, removed: 0, files: 0 },
    };
  }
  let branch: string | null = null;
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 1500,
    });
    if (r.status === 0) branch = r.stdout.trim() || null;
  } catch {}

  const { base, diffBase } = resolveDiffBase(repoRoot, mode, branch);
  const files = parseDiff(runGitDiff(repoRoot, diffBase));
  const total = files.reduce(
    (acc, f) => ({
      added: acc.added + f.added,
      removed: acc.removed + f.removed,
      files: acc.files + 1,
    }),
    { added: 0, removed: 0, files: 0 },
  );
  return { repoRoot, branch, base, mode, files, total };
}

export function getFileDiffFor(
  cwdRaw: string,
  path: string,
  context: number,
  mode: DiffMode = 'branch',
): DiffFile | null {
  const cwd = expandHome(cwdRaw);
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return null;
  const branch = safeRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const { diffBase } = resolveDiffBase(repoRoot, mode, branch);
  const raw = runGitDiff(repoRoot, diffBase, [`--unified=${context}`, '--', path]);
  return parseDiff(raw)[0] ?? null;
}

function resolveMode(raw: string | undefined): DiffMode {
  return raw === 'working' ? 'working' : 'branch';
}

export function registerDiffRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { tabId?: string; cwd?: string; mode?: string } }>('/diff', async (req) =>
    getDiffFor(resolveCwd(req.query.cwd, req.query.tabId), resolveMode(req.query.mode)),
  );

  app.get<{
    Querystring: { tabId?: string; cwd?: string; path: string; context?: string; mode?: string };
  }>('/diff/file', async (req) => {
    const ctx = Math.max(
      0,
      parseInt(req.query.context ?? String(DEFAULT_FILE_CONTEXT), 10) || DEFAULT_FILE_CONTEXT,
    );
    const file = getFileDiffFor(
      resolveCwd(req.query.cwd, req.query.tabId),
      req.query.path,
      ctx,
      resolveMode(req.query.mode),
    );
    return { file };
  });
}
