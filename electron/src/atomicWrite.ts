import fs from 'node:fs';
import path from 'node:path';

// Write via tmp + rename so a crash mid-write can't leave a half-written file.
// The parent directory is created if missing. Errors are swallowed with a log
// line because all current callers are best-effort persistence.
export function atomicWriteFile(absPath: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const tmp = absPath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, absPath);
  } catch (err) {
    console.error('[grove] atomicWriteFile failed for', absPath, err);
  }
}
