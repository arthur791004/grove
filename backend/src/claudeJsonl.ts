import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code stores conversation transcripts under
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// where the project directory is the absolute cwd with every non-alphanumeric
// character replaced by '-' (e.g. /Users/x/code/grove → -Users-x-code-grove).
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function projectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(cwd));
}

// Path of the most recently modified .jsonl transcript for a workspace cwd,
// or null when the workspace has no Claude history.
export function findLatestSessionJsonl(cwd: string): string | null {
  const dir = projectDir(cwd);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestMtime = -1;
  for (const f of entries) {
    const full = path.join(dir, f);
    try {
      const m = fs.statSync(full).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        best = full;
      }
    } catch {}
  }
  return best;
}

// Plain text of the last assistant turn that carries actual prose (turns made
// up only of tool calls are skipped), truncated to maxLen.
export function readLastAssistantText(jsonlPath: string, maxLen = 1200): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = obj as { type?: string; message?: { content?: unknown } };
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (c): c is { type: string; text: string } =>
          !!c && typeof c === 'object' && (c as { type?: string }).type === 'text',
      )
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (!text) continue;
    return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
  }
  return null;
}
