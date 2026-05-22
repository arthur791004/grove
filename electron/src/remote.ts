import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite';

// Electron owns ~/.grove/remote.json; the backend daemon reads it on startup
// (see backend/src/remoteConfig.ts). The two workspaces don't share modules,
// so the file shape is deliberately duplicated.
const GROVE_DIR = path.join(os.homedir(), '.grove');
const REMOTE_FILE = path.join(GROVE_DIR, 'remote.json');
const BACKEND_PORT = Number(process.env.GROVE_BACKEND_PORT ?? 4317);

export interface RemoteConfig {
  enabled: boolean;
  token: string;
}

export interface RemoteStatus {
  enabled: boolean;
  token: string | null;
  tailscaleIp: string | null;
  port: number;
  // Ready-to-open connect URL — null until both Tailscale is up (so we have an
  // address) and a token exists.
  url: string | null;
}

function read(): RemoteConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(REMOTE_FILE, 'utf8'));
    if (typeof raw?.token !== 'string' || !raw.token) return null;
    return { enabled: raw.enabled === true, token: raw.token };
  } catch {
    return null;
  }
}

// Toggle remote mode. The token is generated once on first enable and then
// reused across toggles so a previously paired phone keeps working.
export function setRemoteEnabled(enabled: boolean): RemoteConfig {
  const existing = read();
  const config: RemoteConfig = {
    enabled,
    token: existing?.token ?? crypto.randomBytes(24).toString('base64url'),
  };
  fs.mkdirSync(GROVE_DIR, { recursive: true });
  atomicWriteFile(REMOTE_FILE, JSON.stringify(config, null, 2));
  return config;
}

// Tailscale addresses live in the 100.64.0.0/10 CGNAT range.
function isTailscaleIp(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (!m) return false;
  return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

// The Mac's own Tailscale address, if Tailscale is up. Read straight from the
// OS interface list so we don't depend on the `tailscale` CLI being on PATH.
function tailscaleIp(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && isTailscaleIp(a.address)) return a.address;
    }
  }
  return null;
}

export function remoteStatus(): RemoteStatus {
  const config = read();
  const ip = tailscaleIp();
  const token = config?.token ?? null;
  return {
    enabled: config?.enabled === true,
    token,
    tailscaleIp: ip,
    port: BACKEND_PORT,
    url: ip && token ? `http://${ip}:${BACKEND_PORT}/?token=${encodeURIComponent(token)}` : null,
  };
}
