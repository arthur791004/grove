import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';

// When the Electron main process spawns the backend it sets GROVE_LOG_FILE and
// tees our stdout/stderr into grove.log — backend-side file logging would just
// duplicate that. So we only write our own file when running standalone
// (the `dev:backend` script), and land it next to the home dir.
const STANDALONE = !process.env.GROVE_LOG_FILE;
const LOG_FILE = path.join(os.homedir(), '.grove', 'backend.log');

function write(line: string) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* logging must never throw */ }
}

function format(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 3 })))
    .join(' ');
}

export function setupBackendLogging(): void {
  if (!STANDALONE) return;
  try {
    if (fs.statSync(LOG_FILE).size > 5_000_000) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch { /* file may not exist yet */ }
  write(`--- backend session start (node ${process.versions.node}) ---`);

  for (const method of ['error', 'warn'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      write(`[backend:${method}] ${format(args)}`);
    };
  }
  process.on('uncaughtException', (err) => {
    write(`[backend] uncaughtException: ${err?.stack ?? String(err)}`);
    process.stderr.write(`${err?.stack ?? String(err)}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    write(`[backend] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });
}
