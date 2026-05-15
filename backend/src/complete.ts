import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

interface Completion {
  value: string;
  label: string;
  kind: 'dir' | 'file' | 'branch' | 'script';
}

function listEntries(cwd: string, fragment: string, dirsOnly: boolean): Completion[] {
  const expanded = expandHome(fragment);
  const isAbsolute = path.isAbsolute(expanded);
  const base = isAbsolute
    ? expanded.endsWith('/')
      ? expanded
      : path.dirname(expanded)
    : expanded.endsWith('/')
      ? path.join(cwd, expanded)
      : path.join(cwd, path.dirname(expanded) || '.');
  const prefix = expanded.endsWith('/') ? '' : path.basename(expanded);
  return safe<Completion[]>(() => {
    const entries = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name.startsWith(prefix));
    const filtered = dirsOnly ? entries.filter((e) => e.isDirectory()) : entries;
    if (!dirsOnly) {
      filtered.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    return filtered.slice(0, 50).map((e) => {
      const dirPath = path.dirname(expanded) === '.' ? '' : path.dirname(expanded) + '/';
      const ending = e.isDirectory() ? '/' : '';
      const value = (expanded.endsWith('/') ? expanded : dirPath) + e.name + ending;
      return {
        value,
        label: e.name + ending,
        kind: e.isDirectory() ? ('dir' as const) : ('file' as const),
      };
    });
  }, []);
}

function gitBranches(cwd: string, prefix: string): Completion[] {
  const r = spawnSync('git', ['-C', cwd, 'branch', '--format=%(refname:short)'], {
    encoding: 'utf8',
    timeout: 600,
  });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((b) => b && b.startsWith(prefix))
    .slice(0, 50)
    .map((b) => ({ value: b, label: b, kind: 'branch' as const }));
}

function npmScripts(cwd: string, prefix: string): Completion[] {
  return safe<Completion[]>(() => {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const scripts = pkg?.scripts ? Object.keys(pkg.scripts) : [];
    return scripts
      .filter((s) => s.startsWith(prefix))
      .slice(0, 50)
      .map((s) => ({ value: s, label: s, kind: 'script' as const }));
  }, []);
}

interface ParsedInput {
  command: string[]; // e.g. ['git', 'checkout']
  fragment: string; // current word being typed
  prefix: string; // input minus fragment (preserves whitespace)
}

function parseInput(input: string): ParsedInput {
  // Find boundary of last token (the one being typed)
  const m = input.match(/^(.*?)(\S*)$/);
  const prefix = m ? m[1] : '';
  const fragment = m ? m[2] : '';
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  return { command: tokens, fragment, prefix };
}

function commandKey(tokens: string[]): string {
  if (tokens.length === 0) return '';
  const first = tokens[0];
  // Treat known subcommands as compound keys
  const second = tokens[1];
  if (['git', 'npm', 'yarn', 'pnpm', 'docker', 'kubectl'].includes(first) && second) {
    return `${first} ${second}`;
  }
  return first;
}

function suggestions(cwd: string, parsed: ParsedInput): Completion[] {
  const key = commandKey(parsed.command);
  const frag = parsed.fragment;

  switch (key) {
    case 'cd':
    case 'pushd':
    case 'rmdir':
      return listEntries(cwd, frag, true);
    case 'ls':
    case 'cat':
    case 'less':
    case 'head':
    case 'tail':
    case 'cp':
    case 'mv':
    case 'rm':
    case 'touch':
    case 'vim':
    case 'vi':
    case 'nano':
    case 'code':
    case 'open':
      return listEntries(cwd, frag, false);
    case 'git checkout':
    case 'git switch':
    case 'git merge':
    case 'git rebase':
    case 'git branch':
      return gitBranches(cwd, frag);
    case 'npm run':
    case 'yarn run':
    case 'pnpm run':
      return npmScripts(cwd, frag);
    default:
      return [];
  }
}

export function registerCompleteRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { cwd?: string; input?: string } }>('/complete', async (req) => {
    const cwd = req.query.cwd || os.homedir();
    const input = req.query.input ?? '';
    const parsed = parseInput(input);
    const matches = suggestions(cwd, parsed);
    return {
      completions: matches.map((m) => ({
        value: parsed.prefix + m.value,
        label: m.label,
        kind: m.kind,
      })),
    };
  });
}
