import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULTS = [
  'ls',
  'ls -la',
  'ls -lah',
  'cd ',
  'cd ..',
  'cd -',
  'pwd',
  'clear',
  'history',
  'cat ',
  'less ',
  'tail -f ',
  'head ',
  'mkdir ',
  'rm ',
  'rm -rf ',
  'mv ',
  'cp ',
  'touch ',
  'echo ',
  'grep ',
  'find ',
  'which ',
  'git status',
  'git pull',
  'git push',
  'git log',
  'git log --oneline',
  'git diff',
  'git diff --stat',
  'git commit -m ""',
  'git commit --amend',
  'git checkout ',
  'git checkout -b ',
  'git branch',
  'git stash',
  'git stash pop',
  'git add .',
  'git add -p',
  'npm install',
  'npm i ',
  'npm run dev',
  'npm run build',
  'npm start',
  'npm test',
  'npm run',
  'yarn',
  'yarn install',
  'yarn dev',
  'yarn build',
  'pnpm install',
  'pnpm dev',
  'pnpm build',
  'docker ps',
  'docker compose up',
  'docker compose down',
  'docker logs ',
  'kubectl get pods',
  'kubectl logs ',
  'kubectl describe ',
  'curl ',
  'ssh ',
  'code .',
  'open .',
];

interface CacheEntry {
  ts: number;
  list: string[];
  history: string[];
}
const CACHE_TTL = 10_000;
let cache: CacheEntry | null = null;

function readZshHistory(): string[] {
  const file = path.join(os.homedir(), '.zsh_history');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = lines.length - 1; i >= 0; i--) {
      let line = lines[i];
      if (!line) continue;
      // Extended history format: ": <timestamp>:<duration>;<cmd>"
      const m = line.match(/^: \d+:\d+;(.*)$/);
      if (m) line = m[1];
      line = line.trim();
      if (!line) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
      if (out.length >= 500) break;
    }
    return out;
  } catch {
    return [];
  }
}

function appendZshHistory(cmd: string) {
  const trimmed = cmd.trim();
  if (!trimmed) return;
  // zsh extended history format: ": <epoch>:<elapsed>;<command>". Newlines in
  // the command must be escaped as "\\\n" so multi-line commands are read back
  // as a single history entry.
  const ts = Math.floor(Date.now() / 1000);
  const escaped = trimmed.replace(/\\/g, '\\\\').replace(/\n/g, '\\\n');
  const line = `: ${ts}:0;${escaped}\n`;
  const file = path.join(os.homedir(), '.zsh_history');
  try {
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    // Invalidate the in-memory cache so the next /completions request reflects
    // the new entry — otherwise the renderer's history would lag by up to 10s.
    cache = null;
  } catch (err) {
    console.error('[grove] failed to append to ~/.zsh_history:', err);
  }
}

export function registerCompletionRoutes(app: FastifyInstance) {
  app.get('/completions', async () => {
    const now = Date.now();
    if (!cache || now - cache.ts > CACHE_TTL) {
      const history = readZshHistory();
      const seen = new Set<string>(history);
      const merged = [...history];
      for (const cmd of DEFAULTS) {
        if (!seen.has(cmd)) {
          merged.push(cmd);
          seen.add(cmd);
        }
      }
      cache = { ts: now, list: merged, history };
    }
    return { completions: cache.list, history: cache.history };
  });

  app.post<{ Body: { cmd?: string } }>('/history', async (req, reply) => {
    const cmd = typeof req.body?.cmd === 'string' ? req.body.cmd : '';
    appendZshHistory(cmd);
    return reply.send({ ok: true });
  });
}
