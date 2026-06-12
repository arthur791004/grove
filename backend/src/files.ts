import type { FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionCwd } from './sessions.js';
import { expandHome, findRepoRoot, shortPath } from './gitUtil.js';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  mtimeMs: number;
}

export interface FilesResponse {
  cwd: string;
  shortCwd: string;
  parent: string | null;
  entries: FileEntry[];
  cwdReady: boolean;
}

function listDir(dir: string): FileEntry[] {
  let raw: fs.Dirent[];
  try {
    raw = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: FileEntry[] = [];
  for (const ent of raw) {
    if (ent.name.startsWith('.')) continue; // hide dotfiles by default
    const full = path.join(dir, ent.name);
    let isDir = ent.isDirectory();
    let size: number | null = null;
    let mtimeMs = 0;
    try {
      const stat = fs.statSync(full);
      isDir = stat.isDirectory();
      size = isDir ? null : stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {}
    entries.push({ name: ent.name, path: full, isDir, size, mtimeMs });
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

const MAX_PREVIEW_BYTES = 512 * 1024;
const SEARCH_RESULT_LIMIT = 200;
const SEARCH_WALK_MAX_FILES = 50_000;
const SEARCH_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
]);

function gitListFiles(repoRoot: string): string[] | null {
  try {
    const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status !== 0) return null;
    return r.stdout.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function walkFiles(root: string, max: number): string[] {
  const out: string[] = [];
  function recurse(dir: string) {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= max) return;
      if (ent.name.startsWith('.')) continue;
      if (SEARCH_IGNORE.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) recurse(full);
      else out.push(path.relative(root, full));
    }
  }
  recurse(root);
  return out;
}

interface SearchResult {
  path: string;
  abs: string;
  matchIdx: number;
}

function rankMatches(candidates: string[], q: string, limit: number): SearchResult[] {
  const qLower = q.toLowerCase();
  const out: SearchResult[] = [];
  for (const p of candidates) {
    const lower = p.toLowerCase();
    const idx =
      lower.lastIndexOf('/') >= 0
        ? lower.slice(lower.lastIndexOf('/') + 1).indexOf(qLower)
        : lower.indexOf(qLower);
    if (idx === -1) {
      const fullIdx = lower.indexOf(qLower);
      if (fullIdx === -1) continue;
      out.push({ path: p, abs: '', matchIdx: fullIdx + 1000 });
    } else {
      out.push({ path: p, abs: '', matchIdx: idx });
    }
  }
  // Earliest basename match first; ties broken by path length.
  out.sort((a, b) => a.matchIdx - b.matchIdx || a.path.length - b.path.length);
  return out.slice(0, limit);
}

export function registerFileRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { tabId?: string; path?: string } }>('/files', async (req) => {
    const sessCwd = req.query.tabId ? sessionCwd(req.query.tabId) : null;
    // Distinguish "shell hasn't emitted its cwd yet" from a real listing —
    // otherwise the file browser would default to ~ on startup.
    if (req.query.tabId && !req.query.path && !sessCwd) {
      return {
        cwd: '',
        shortCwd: '',
        parent: null,
        entries: [],
        cwdReady: false,
      } satisfies FilesResponse;
    }
    const baseCwd = expandHome(sessCwd || os.homedir());
    const target = req.query.path ? expandHome(req.query.path) : baseCwd;
    const resolved = path.isAbsolute(target) ? target : path.resolve(baseCwd, target);
    const parent = path.dirname(resolved);
    return {
      cwd: resolved,
      shortCwd: shortPath(resolved),
      parent: parent !== resolved ? parent : null,
      entries: listDir(resolved),
      cwdReady: true,
    } satisfies FilesResponse;
  });

  app.get<{ Querystring: { tabId?: string; q: string; limit?: string } }>(
    '/files/search',
    async (req) => {
      const sessCwd = req.query.tabId ? sessionCwd(req.query.tabId) : null;
      if (!sessCwd) return { cwdReady: false, root: '', results: [] };
      const q = (req.query.q ?? '').trim();
      if (!q) return { cwdReady: true, root: shortPath(sessCwd), results: [] };
      const limit = Math.min(
        parseInt(req.query.limit ?? String(SEARCH_RESULT_LIMIT), 10) || SEARCH_RESULT_LIMIT,
        1000,
      );
      const repoRoot = findRepoRoot(sessCwd);
      const searchRoot = repoRoot ?? sessCwd;
      const tracked = repoRoot ? gitListFiles(repoRoot) : null;
      const candidates = tracked ?? walkFiles(searchRoot, SEARCH_WALK_MAX_FILES);
      const ranked = rankMatches(candidates, q, limit);
      for (const r of ranked) r.abs = path.join(searchRoot, r.path);
      return { cwdReady: true, root: shortPath(searchRoot), results: ranked };
    },
  );

  // Content search via ripgrep. Returns matches grouped by file with a short
  // preview of the matching line. Falls back to empty results (with a flag)
  // when `rg` isn't on PATH so the UI can surface that gracefully.
  app.get<{
    Querystring: { tabId?: string; q: string; limit?: string; max?: string };
  }>('/files/grep', async (req) => {
    const sessCwd = req.query.tabId ? sessionCwd(req.query.tabId) : null;
    if (!sessCwd) return { cwdReady: false, root: '', files: [], rgAvailable: true };
    const q = (req.query.q ?? '').trim();
    if (!q) return { cwdReady: true, root: shortPath(sessCwd), files: [], rgAvailable: true };
    const fileLimit = Math.min(
      parseInt(req.query.limit ?? '40', 10) || 40,
      200,
    );
    const perFileLimit = Math.min(
      parseInt(req.query.max ?? '5', 10) || 5,
      50,
    );
    const repoRoot = findRepoRoot(sessCwd);
    const searchRoot = repoRoot ?? sessCwd;
    const r = spawnSync(
      'rg',
      [
        '--json',
        '--smart-case',
        '--fixed-strings',
        '--hidden',
        '-g',
        '!.git',
        '-g',
        '!node_modules',
        '--max-columns=400',
        '--max-count=' + perFileLimit,
        '--',
        q,
        searchRoot,
      ],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 },
    );
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { cwdReady: true, root: shortPath(searchRoot), files: [], rgAvailable: false };
    }
    interface GrepHit { line: number; col: number; preview: string }
    interface GrepFile { path: string; abs: string; hits: GrepHit[] }
    const filesMap = new Map<string, GrepFile>();
    let fileCount = 0;
    for (const raw of r.stdout.split('\n')) {
      if (!raw) continue;
      let evt: { type: string; data: unknown };
      try {
        evt = JSON.parse(raw);
      } catch {
        continue;
      }
      if (evt.type !== 'match') continue;
      const data = evt.data as {
        path: { text?: string };
        lines: { text?: string };
        line_number: number;
        submatches: { start: number }[];
      };
      const abs = data.path.text ?? '';
      if (!abs) continue;
      const rel = path.relative(searchRoot, abs);
      let file = filesMap.get(abs);
      if (!file) {
        if (fileCount >= fileLimit) continue;
        fileCount++;
        file = { path: rel, abs, hits: [] };
        filesMap.set(abs, file);
      }
      if (file.hits.length >= perFileLimit) continue;
      const preview = (data.lines.text ?? '').replace(/\r?\n$/, '').slice(0, 400);
      const col = (data.submatches[0]?.start ?? 0) + 1;
      file.hits.push({ line: data.line_number, col, preview });
    }
    return {
      cwdReady: true,
      root: shortPath(searchRoot),
      files: [...filesMap.values()],
      rgAvailable: true,
    };
  });

  app.get<{ Querystring: { tabId?: string; path: string; cwd?: string } }>(
    '/file/resolve',
    async (req) => {
      const sessCwd = req.query.tabId ? sessionCwd(req.query.tabId) : null;
      const baseCwd = expandHome(req.query.cwd || sessCwd || os.homedir());
      const target = expandHome(req.query.path);
      const resolved = path.isAbsolute(target) ? target : path.resolve(baseCwd, target);
      try {
        const stat = fs.statSync(resolved);
        return { exists: true, isFile: stat.isFile(), isDir: stat.isDirectory(), abs: resolved };
      } catch {
        return { exists: false, isFile: false, isDir: false, abs: resolved };
      }
    },
  );

  app.get<{ Querystring: { tabId?: string; path: string } }>('/file/content', async (req) => {
    const sessCwd = req.query.tabId ? sessionCwd(req.query.tabId) : null;
    const baseCwd = expandHome(sessCwd || os.homedir());
    const target = expandHome(req.query.path);
    const resolved = path.isAbsolute(target) ? target : path.resolve(baseCwd, target);
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory())
        return { error: 'Is a directory', content: null, truncated: false, size: stat.size };
      if (stat.size > MAX_PREVIEW_BYTES) {
        const fd = fs.openSync(resolved, 'r');
        const buf = Buffer.allocUnsafe(MAX_PREVIEW_BYTES);
        const read = fs.readSync(fd, buf, 0, MAX_PREVIEW_BYTES, 0);
        fs.closeSync(fd);
        return {
          content: buf.subarray(0, read).toString('utf8'),
          truncated: true,
          size: stat.size,
          error: null,
        };
      }
      const content = fs.readFileSync(resolved, 'utf8');
      return { content, truncated: false, size: stat.size, error: null };
    } catch (err) {
      return {
        error: String((err as Error).message || err),
        content: null,
        truncated: false,
        size: 0,
      };
    }
  });

  app.post<{ Body: { tabId?: string; path: string; content: string } }>(
    '/file/content',
    async (req) => {
      const { tabId, path: target, content } = req.body || ({} as any);
      if (typeof target !== 'string' || typeof content !== 'string') {
        return { ok: false, error: 'Invalid request' };
      }
      const sessCwd = tabId ? sessionCwd(tabId) : null;
      const baseCwd = expandHome(sessCwd || os.homedir());
      const expanded = expandHome(target);
      const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd, expanded);
      try {
        // Refuse to clobber a directory; let creating new files through.
        try {
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) return { ok: false, error: 'Is a directory' };
        } catch {
          // File doesn't exist yet — write will create it.
        }
        fs.writeFileSync(resolved, content, 'utf8');
        const stat = fs.statSync(resolved);
        return { ok: true, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch (err) {
        return { ok: false, error: String((err as Error).message || err) };
      }
    },
  );
}
