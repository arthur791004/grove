// Build the grove-termios native addon if it isn't already compiled.
// Failure is non-fatal — sessions.ts falls back to "no termios info" when
// the addon is missing.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const addonDir = resolve(here, '..', 'backend', 'native', 'grove-termios');
const built = resolve(addonDir, 'build', 'Release', 'grove_termios.node');
if (existsSync(built)) process.exit(0);

const r = spawnSync('npx', ['node-gyp', 'rebuild'], {
  cwd: addonDir,
  stdio: 'inherit',
});
if (r.status !== 0) {
  console.warn('[grove-termios] build failed; auto TUI detection disabled');
}
process.exit(0);
