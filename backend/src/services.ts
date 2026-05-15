import type { FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { sessionCwd } from './sessions.js';

export interface ServiceEntry {
  port: number;
  host: string;
  pid: number;
  cmd: string;
  cwd: string | null;
  url: string;
}

// lsof -F output: each record is a block of `XValue` lines per fd. We scan for
// process headers (p<pid>, c<cmd>) and TCP listen entries (n<host>:<port>).
function listListeningPorts(): Array<{ pid: number; cmd: string; host: string; port: number }> {
  const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  const out: Array<{ pid: number; cmd: string; host: string; port: number }> = [];
  let pid = 0;
  let cmd = '';
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      pid = parseInt(val, 10) || 0;
      cmd = '';
    } else if (tag === 'c') {
      cmd = val;
    } else if (tag === 'n') {
      // host:port (host may be *, [::1], 127.0.0.1, etc.)
      const lastColon = val.lastIndexOf(':');
      if (lastColon === -1) continue;
      const host = val.slice(0, lastColon);
      const port = parseInt(val.slice(lastColon + 1), 10);
      if (!port) continue;
      out.push({ pid, cmd, host, port });
    }
  }
  return out;
}

// Resolve a process's cwd via lsof. Empty string on failure (kernel threads,
// permission denied, etc.) — callers should treat null as "unknown".
function pidCwd(pid: number): string | null {
  const r = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('n')) return line.slice(1) || null;
  }
  return null;
}

function isLocalish(host: string): boolean {
  return (
    host === '*' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '::'
  );
}

function urlFor(host: string, port: number): string {
  const h =
    host === '*' || host === '0.0.0.0' || host === '::'
      ? '127.0.0.1'
      : host.replace(/^\[|\]$/g, '');
  return `http://${h}:${port}`;
}

// Walk up from `child` looking for `ancestor`. Both should be absolute paths;
// trailing slashes are tolerated.
function isWithin(child: string, ancestor: string): boolean {
  const a = path.resolve(ancestor).replace(/\/+$/, '');
  const c = path.resolve(child).replace(/\/+$/, '');
  if (c === a) return true;
  return c.startsWith(a + path.sep);
}

export function registerServiceRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { tabId?: string; cwd?: string; all?: string } }>(
    '/services',
    async (req) => {
      const all = req.query.all === '1' || req.query.all === 'true';
      const sessCwd = req.query.tabId ? sessionCwd(req.query.tabId) : null;
      const cwd = sessCwd ?? req.query.cwd;
      // If a tabId is provided but its shell hasn't reported cwd yet, return
      // cwdReady:false so the panel can show a loader instead of an unfiltered
      // global service list.
      if (req.query.tabId && !sessCwd && !all) {
        return { services: [], cwd: null, cwdReady: false };
      }
      const raw = listListeningPorts();
      // Hide non-localhost listeners (DNS, mDNS, system services) by default.
      const local = raw.filter((e) => isLocalish(e.host));
      // Dedupe by (pid, port) — lsof emits both IPv4 and IPv6 rows for the
      // same listener.
      const seen = new Set<string>();
      const unique = local.filter((e) => {
        const k = `${e.pid}:${e.port}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const cwdCache = new Map<number, string | null>();
      const out: ServiceEntry[] = [];
      for (const e of unique) {
        let pcwd = cwdCache.get(e.pid);
        if (pcwd === undefined) {
          pcwd = pidCwd(e.pid);
          cwdCache.set(e.pid, pcwd);
        }
        if (!all && cwd && pcwd && !isWithin(pcwd, cwd)) continue;
        out.push({
          port: e.port,
          host: e.host,
          pid: e.pid,
          cmd: e.cmd,
          cwd: pcwd,
          url: urlFor(e.host, e.port),
        });
      }
      out.sort((a, b) => a.port - b.port);
      return { services: out, cwd: cwd ?? null, cwdReady: true };
    },
  );
}
