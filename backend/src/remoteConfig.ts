import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ~/.grove/remote.json is the single source of truth for remote mode, shared
// between Electron (the writer — see electron/src/remote.ts) and the daemon
// (the reader, here). The two workspaces don't share modules, so the shape is
// deliberately duplicated.
const REMOTE_FILE = path.join(os.homedir(), '.grove', 'remote.json');

export interface RemoteConfig {
  enabled: boolean;
  token: string;
}

// Returns null when the file is absent or unparseable — remote mode simply
// stays off, which is the safe default.
export function readRemoteConfig(): RemoteConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(REMOTE_FILE, 'utf8'));
    if (typeof raw?.token !== 'string' || !raw.token) return null;
    return { enabled: raw.enabled === true, token: raw.token };
  } catch {
    return null;
  }
}

// Loopback covers the Electron app itself plus anything else on this machine.
// A dual-stack socket reports IPv4 peers as `::ffff:127.0.0.1`, so strip that
// prefix before matching the 127.0.0.0/8 range.
export function isLoopback(ip: string): boolean {
  const a = ip.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

// Tailscale hands every node an address in the 100.64.0.0/10 CGNAT range.
// Treating that range as "the tailnet" lets remote mode accept tailnet peers
// without depending on the `tailscale` CLI or a specific interface name.
export function isTailscale(ip: string): boolean {
  const a = ip.replace(/^::ffff:/, '');
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (!m) return false;
  const first = Number(m[1]);
  const second = Number(m[2]);
  return first === 100 && second >= 64 && second <= 127;
}
