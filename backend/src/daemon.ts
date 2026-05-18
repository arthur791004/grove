import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const GROVE_DIR = path.join(os.homedir(), '.grove');
const PID_FILE = path.join(GROVE_DIR, 'daemon.pid');
const LOG_FILE = path.join(GROVE_DIR, 'daemon.log');
const PORT = Number(process.env.GROVE_BACKEND_PORT ?? 4317);
const LOG_MAX_BYTES = 5_000_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function unlinkPid(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* already gone */
  }
}

async function startDaemon(): Promise<void> {
  fs.mkdirSync(GROVE_DIR, { recursive: true });

  const existing = readPid();
  if (existing !== null) {
    if (isAlive(existing)) {
      console.error(`Grove daemon already running (pid ${existing})`);
      process.exit(1);
    }
    unlinkPid();
  }

  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch {
    /* file may not exist yet */
  }

  // Detached daemons have no controlling terminal; redirect stdout/stderr to
  // the log file so console output isn't silently dropped.
  const logFd = fs.openSync(LOG_FILE, 'a');
  const writeLog = ((chunk: string | Uint8Array): boolean => {
    try {
      fs.writeSync(logFd, chunk as never);
    } catch {
      /* logging must never throw */
    }
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = writeLog;
  process.stderr.write = writeLog;

  fs.writeFileSync(PID_FILE, String(process.pid));

  process.on('exit', unlinkPid);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      console.log(`[daemon] ${sig}, shutting down (pid ${process.pid})`);
      unlinkPid();
      process.exit(0);
    });
  }
  process.on('uncaughtException', (err) => {
    console.error(`[daemon] uncaughtException: ${err?.stack ?? String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(
      `[daemon] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
    );
  });

  console.log(
    `[daemon] starting on 127.0.0.1:${PORT} (pid ${process.pid}, node ${process.versions.node})`,
  );
  await startServer({ port: PORT });
  console.log(`[daemon] ready`);
}

function stopDaemon(): void {
  const pid = readPid();
  if (pid === null) {
    console.log('Grove daemon not running');
    return;
  }
  if (!isAlive(pid)) {
    console.log('Grove daemon not running (stale PID, cleaning up)');
    unlinkPid();
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Grove daemon stopped (pid ${pid})`);
  } catch (err) {
    console.error(`Failed to stop Grove daemon (pid ${pid}):`, err);
    process.exit(1);
  }
}

function statusDaemon(): void {
  const pid = readPid();
  if (pid === null) {
    console.log('Grove daemon: not running');
    return;
  }
  if (isAlive(pid)) {
    console.log(`Grove daemon: running (pid ${pid}, port ${PORT})`);
  } else {
    console.log('Grove daemon: not running (stale PID)');
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'start';
  switch (cmd) {
    case 'start':
      await startDaemon();
      return;
    case 'stop':
      stopDaemon();
      return;
    case 'status':
      statusDaemon();
      return;
    default:
      console.error(`Usage: grove-daemon <start|stop|status>`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
