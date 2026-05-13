import type { FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { sessionCwd } from './sessions.js';
import { expandHome, findRepoRoot } from './gitUtil.js';

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
      else if (l.startsWith('Binary files')) { binary = true; }
      else if (l.startsWith('@@ ')) { inHunk = true; patchLines.push(l); }
      else if (inHunk) {
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
  files: DiffFile[];
  total: { added: number; removed: number; files: number };
}

function runGitDiff(repoRoot: string, extraArgs: string[] = []): string {
  try {
    const r = spawnSync(
      'git',
      ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', ...extraArgs],
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

export function getDiffFor(cwdRaw: string): DiffResponse {
  const cwd = expandHome(cwdRaw);
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    return { repoRoot: null, branch: null, files: [], total: { added: 0, removed: 0, files: 0 } };
  }
  let branch: string | null = null;
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 1500,
    });
    if (r.status === 0) branch = r.stdout.trim() || null;
  } catch {}

  const files = parseDiff(runGitDiff(repoRoot));
  const total = files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed, files: acc.files + 1 }),
    { added: 0, removed: 0, files: 0 },
  );
  return { repoRoot, branch, files, total };
}

export function getFileDiffFor(cwdRaw: string, path: string, context: number): DiffFile | null {
  const cwd = expandHome(cwdRaw);
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return null;
  const raw = runGitDiff(repoRoot, [`--unified=${context}`, '--', path]);
  return parseDiff(raw)[0] ?? null;
}

export function registerDiffRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { tabId?: string; cwd?: string } }>('/diff', async (req) =>
    getDiffFor(resolveCwd(req.query.cwd, req.query.tabId)),
  );

  app.get<{ Querystring: { tabId?: string; cwd?: string; path: string; context?: string } }>(
    '/diff/file',
    async (req) => {
      const ctx = Math.max(0, parseInt(req.query.context ?? String(DEFAULT_FILE_CONTEXT), 10) || DEFAULT_FILE_CONTEXT);
      const file = getFileDiffFor(resolveCwd(req.query.cwd, req.query.tabId), req.query.path, ctx);
      return { file };
    },
  );
}
