import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface BlockRecord {
  cmd: string;
  cwd: string;
  output: string;
  exit: number | null;
  durationMs: number | null;
}

const DIR = path.join(os.homedir(), '.grove', 'blocks');

function ensureDir() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {}
}

function fileFor(tabId: string): string {
  // tabIds are random kebab strings from store.ts uid(); safe as filenames.
  return path.join(DIR, `${tabId}.json`);
}

export function loadBlocks(tabId: string): BlockRecord[] {
  try {
    const raw = fs.readFileSync(fileFor(tabId), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((b) => b && typeof b.cmd === 'string');
  } catch {}
  return [];
}

const pending = new Map<string, NodeJS.Timeout>();

export function saveBlocks(tabId: string, blocks: BlockRecord[]): void {
  const existing = pending.get(tabId);
  if (existing) clearTimeout(existing);
  pending.set(
    tabId,
    setTimeout(() => {
      pending.delete(tabId);
      ensureDir();
      try {
        const tmp = fileFor(tabId) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(blocks), 'utf8');
        fs.renameSync(tmp, fileFor(tabId));
      } catch (err) {
        console.error('[grove] failed to persist blocks for', tabId, err);
      }
    }, 250),
  );
}

export function deleteBlocks(tabId: string): void {
  const existing = pending.get(tabId);
  if (existing) {
    clearTimeout(existing);
    pending.delete(tabId);
  }
  try {
    fs.unlinkSync(fileFor(tabId));
  } catch {}
}
