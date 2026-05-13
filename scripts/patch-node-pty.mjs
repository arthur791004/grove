// node-pty 1.1.0 has a buggy asar→asar.unpacked path rewrite in
// lib/unixTerminal.js: `helperPath.replace('app.asar', 'app.asar.unpacked')`
// matches the first 'app.asar' substring, so a path that already contains
// 'app.asar.unpacked/...' becomes 'app.asar.unpacked.unpacked/...' (bogus).
// posix_spawn then fails with the helper missing, and node-pty reports the
// generic "posix_spawnp failed." which is misdiagnosed as a code-signing
// issue. Guard the replace so it only fires when the path doesn't already
// reference the unpacked variant.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', 'node_modules', 'node-pty', 'lib', 'unixTerminal.js');
if (!existsSync(target)) process.exit(0);

const before = readFileSync(target, 'utf8');
const buggy =
  "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');\n" +
  "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');";
const fixed =
  "if (helperPath.indexOf('app.asar.unpacked') === -1) helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');\n" +
  "if (helperPath.indexOf('node_modules.asar.unpacked') === -1) helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');";

if (before.includes(fixed)) process.exit(0);
if (!before.includes(buggy)) {
  console.warn('[patch-node-pty] expected snippet not found; node-pty version may have changed');
  process.exit(0);
}
writeFileSync(target, before.replace(buggy, fixed));
console.log('[patch-node-pty] applied');
