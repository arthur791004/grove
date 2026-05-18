import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Constants duplicated from backend/src/daemon.ts because the two workspaces
// don't share modules. Keep in sync.
const GROVE_DIR = path.join(os.homedir(), '.grove');
const PID_FILE = path.join(GROVE_DIR, 'daemon.pid');
const PORT = Number(process.env.GROVE_BACKEND_PORT ?? 4317);

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pingHealth(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function resolveDaemonEntry(): string {
  // In packaged builds the daemon lives under app.asar.unpacked (see the
  // electron-builder asarUnpack list) so spawn can find a real on-disk path.
  const raw = path.resolve(__dirname, '../../backend/dist/daemon.js');
  return raw.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function spawnDaemon(): void {
  const child = spawn(process.execPath, [resolveDaemonEntry(), 'start'], {
    // detached + unref + stdio:ignore is what lets the daemon outlive Electron.
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      // Electron binary needs this to behave as plain Node for the daemon script.
      ELECTRON_RUN_AS_NODE: '1',
      GROVE_BACKEND_PORT: String(PORT),
    },
  });
  child.unref();
}

async function waitForDaemon(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingHealth()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Grove daemon failed to start within ${timeoutMs}ms — check ${path.join(GROVE_DIR, 'daemon.log')}`,
  );
}

export async function ensureDaemon(): Promise<void> {
  const pid = readPid();
  if (pid !== null && isAlive(pid) && (await pingHealth())) {
    console.log(`[grove] daemon already running (pid ${pid}), connecting`);
    return;
  }
  console.log('[grove] spawning daemon');
  spawnDaemon();
  await waitForDaemon();
  console.log(`[grove] daemon ready (pid ${readPid() ?? '?'})`);
}

export async function shutdownDaemon(timeoutMs = 2000): Promise<void> {
  const pid = readPid();
  if (pid === null || !isAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}
