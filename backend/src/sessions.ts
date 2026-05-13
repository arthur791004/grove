import * as pty from 'node-pty';
import os from 'node:os';
import { isTmuxAvailable, ensureSession, attachArgs, killSession } from './tmux.js';
import { ensureShellInitDir } from './shellInit.js';
import { findRepoRoot, safeRun, shortPath } from './gitUtil.js';

type WSLike = { send(data: string): void; close(): void };

interface Session {
  tabId: string;
  pty: pty.IPty;
  cols: number;
  rows: number;
  cwd: string;
  nodeVersion: string | null;
  env: Record<string, string>;
  subscribers: Set<WSLike>;
  rawBuffer: string;
  parseBuffer: string;
  parsedOutputBuffer: string;
}

const sessions = new Map<string, Session>();
const MAX_BUFFER = 200_000;

const MARKER_REGEX = /\x1b\]1337;grove-(pre|post);([^\x07\x1b]*)\x07/;
const OSC7_REGEX = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const ENV_REGEX = /\x1b\]1337;grove-env;([^\x07\x1b]*)\x07/g;
// All OSC sequences except OSC 8 (hyperlinks). OSC 8 looks like
//   \e]8;params;url\e\\display\e]8;;\e\\
// We preserve those so the frontend can render clickable paths emitted by
// tools that embed file:// links (rustc, cargo, npm, etc.).
const OSC_ANY = /\x1b\](?!8(?:[;\x07\x1b]|$))[^\x07\x1b]*(?:\x07|\x1b\\)/g;
// All CSI sequences EXCEPT a small whitelist the block view interprets:
//   m  → SGR (colors/styles)
//   K  → EL (erase-in-line)
//   J  → ED (erase-in-display)
//   A  → CUU (cursor up — for redrawing multi-line progress bars)
//   F  → CPL (cursor previous line)
// Excludes uppercase {A, F, J, K, M} and lowercase {m}.
const CSI_NON_SGR = /\x1b\[[0-9;?]*[B-EG-ILN-Za-ln-z]/g;
// Two-byte ESC sequences: keypad/cursor/reset, e.g. \x1b=, \x1b>, \x1b7, \x1bM, etc.
const TWO_BYTE_ESC = /\x1b[=>78DEHMNZ()*+\-./<>~\\]/g;
// Any remaining lone ESC that ISN'T the start of an SGR sequence (\x1b[).
// Stripping all \x1b would kill the color escapes we need to preserve.
const LONE_ESC = /\x1b(?!\[)/g;
// Stray bell
const BEL = /\x07/g;

const CLEAR_SEQ = /\x1b\[[23]J|\x1bc/;

const OSC8_RE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
function sanitize(s: string): string {
  if (!s) return s;
  if (s.indexOf('\x1b') === -1 && s.indexOf('\x07') === -1) return s;
  // Extract OSC 8 markers so the rest of sanitize can't strip the ESC \\ ST
  // terminator (TWO_BYTE_ESC includes \\) or the OSC body.
  const links: string[] = [];
  const placeheld = s.replace(OSC8_RE, (m) => {
    links.push(m);
    return `\x00\x01OSC8_${links.length - 1}\x01\x00`;
  });
  const scrubbed = placeheld
    .replace(OSC_ANY, '')
    .replace(CSI_NON_SGR, '')
    .replace(TWO_BYTE_ESC, '')
    .replace(LONE_ESC, '')
    .replace(BEL, '');
  return scrubbed.replace(/\x00\x01OSC8_(\d+)\x01\x00/g, (_, idx) => links[parseInt(idx, 10)]);
}

// Walk the buffer skipping complete escape sequences. Returns the highest index
// where we can safely cut without splitting a sequence (CSI, OSC, etc.) in two.
function findEmitBoundary(buf: string): number {
  let i = 0;
  while (i < buf.length) {
    const esc = buf.indexOf('\x1b', i);
    if (esc === -1) return buf.length;
    if (esc + 1 >= buf.length) return esc;
    const c = buf[esc + 1];
    if (c === ']') {
      // OSC ... ST (BEL or ESC \)
      let term = buf.indexOf('\x07', esc + 2);
      const stIdx = buf.indexOf('\x1b\\', esc + 2);
      if (stIdx !== -1 && (term === -1 || stIdx < term)) {
        i = stIdx + 2;
      } else if (term !== -1) {
        i = term + 1;
      } else {
        return esc;
      }
    } else if (c === '[') {
      // CSI: params [0-9;?] then a final byte in [@-~]
      let j = esc + 2;
      while (j < buf.length && /[0-9;?]/.test(buf[j])) j++;
      if (j >= buf.length) return esc;
      i = j + 1;
    } else if (c === 'P' || c === 'X' || c === '^' || c === '_') {
      // DCS / SOS / PM / APC ... ST
      const stIdx = buf.indexOf('\x1b\\', esc + 2);
      if (stIdx === -1) return esc;
      i = stIdx + 2;
    } else {
      // Two-byte escape
      i = esc + 2;
    }
  }
  return buf.length;
}

function emitWithClearDetect(session: Session, text: string) {
  if (!text) return;
  function pushOutput(s: string) {
    if (!s) return;
    session.parsedOutputBuffer += s;
    if (session.parsedOutputBuffer.length > MAX_BUFFER) {
      session.parsedOutputBuffer = session.parsedOutputBuffer.slice(-MAX_BUFFER);
    }
    broadcast(session, { type: 'output', data: s });
  }
  if (text.indexOf('\x1b') === -1) { pushOutput(text); return; }
  let rest = text;
  while (true) {
    const m = CLEAR_SEQ.exec(rest);
    if (!m) break;
    pushOutput(sanitize(rest.slice(0, m.index)));
    session.parsedOutputBuffer = '';
    broadcast(session, { type: 'clear' });
    rest = rest.slice(m.index + m[0].length);
  }
  pushOutput(sanitize(rest));
}

interface BlockPre { kind: 'pre'; cmd: string; cwd: string }
interface BlockPost { kind: 'post'; exit: number; durationMs: number }
type BlockEvent = BlockPre | BlockPost;

function send(ws: WSLike, payload: unknown) {
  try { ws.send(JSON.stringify(payload)); } catch {}
}

// Coalesce burst pushes (OSC 7 + env + block-end can all fire in the same
// chunk) into one git-shelling-out + broadcast pass per session.
const ctxDebounce = new Map<string, NodeJS.Timeout>();
const HOME = os.homedir();

function buildCtx(session: Session) {
  const cwd = session.cwd;
  const sCwd = cwd.startsWith(HOME) ? '~' + cwd.slice(HOME.length) : cwd;
  const repoRoot = findRepoRoot(cwd);
  let branch: string | null = session.env.branch ?? null;
  let diff: { added: number; removed: number; files: number } | null = null;
  if (repoRoot) {
    if (!branch) branch = safeRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    const shortstat = safeRun('git', ['diff', '--shortstat'], repoRoot, 1500);
    if (shortstat) {
      const filesM = shortstat.match(/(\d+) files? changed/);
      const addM = shortstat.match(/(\d+) insertions?/);
      const delM = shortstat.match(/(\d+) deletions?/);
      diff = {
        files: filesM ? parseInt(filesM[1], 10) : 0,
        added: addM ? parseInt(addM[1], 10) : 0,
        removed: delM ? parseInt(delM[1], 10) : 0,
      };
    }
  }
  return {
    cwd,
    shortCwd: sCwd,
    repoRoot: repoRoot ? shortPath(repoRoot) : null,
    branch,
    diff,
    node: session.nodeVersion,
    env: session.env,
    cwdReady: true,
  };
}

function pushCtx(session: Session) {
  const existing = ctxDebounce.get(session.tabId);
  if (existing) clearTimeout(existing);
  ctxDebounce.set(session.tabId, setTimeout(() => {
    ctxDebounce.delete(session.tabId);
    if (!sessions.has(session.tabId)) return;
    try {
      const ctx = buildCtx(session);
      broadcast(session, { type: 'ctx', ctx });
    } catch (err) {
      console.error('[grove] failed to build ctx', err);
    }
  }, 150));
}

function broadcast(session: Session, payload: unknown) {
  for (const sub of session.subscribers) send(sub, payload);
}

function decodeMarker(kind: 'pre' | 'post', body: string): BlockEvent | null {
  if (kind === 'pre') {
    const [b64, ...cwdParts] = body.split(';');
    const cwd = cwdParts.join(';');
    let cmd = '';
    try { cmd = Buffer.from(b64, 'base64').toString('utf8'); } catch {}
    return { kind: 'pre', cmd, cwd };
  } else {
    const [exitStr, durStr] = body.split(';');
    const exit = parseInt(exitStr, 10);
    const dur = parseFloat(durStr) * 1000;
    return { kind: 'post', exit: Number.isFinite(exit) ? exit : 0, durationMs: Number.isFinite(dur) ? dur : 0 };
  }
}

function processChunk(session: Session, chunk: string) {
  session.parseBuffer += chunk;

  if (session.parseBuffer.indexOf('\x1b]7;') !== -1) {
    for (const m of session.parseBuffer.matchAll(OSC7_REGEX)) {
      try {
        const decoded = decodeURIComponent(m[1]);
        if (decoded && decoded !== session.cwd) {
          session.cwd = decoded;
          pushCtx(session);
        }
      } catch {}
    }
  }
  if (session.parseBuffer.indexOf('\x1b]1337;grove-env;') !== -1) {
    ENV_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ENV_REGEX.exec(session.parseBuffer)) !== null) {
      const next: Record<string, string> = {};
      for (const pair of m[1].split('|')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const k = pair.slice(0, eq);
        const v = pair.slice(eq + 1);
        if (v) next[k] = v;
      }
      session.env = next;
      session.nodeVersion = next.node || null;
      pushCtx(session);
    }
  }

  while (true) {
    const found = MARKER_REGEX.exec(session.parseBuffer);
    if (!found) {
      // Only emit up to the last complete escape sequence; preserve any
      // in-progress sequence for the next chunk.
      const safeUpto = findEmitBoundary(session.parseBuffer);
      if (safeUpto > 0) {
        const emit = session.parseBuffer.slice(0, safeUpto);
        session.parseBuffer = session.parseBuffer.slice(safeUpto);
        emitWithClearDetect(session, emit);
      }
      break;
    }
    const before = session.parseBuffer.slice(0, found.index);
    if (before) emitWithClearDetect(session, before);
    const event = decodeMarker(found[1] as 'pre' | 'post', found[2]);
    if (event) {
      if (event.kind === 'pre') {
        broadcast(session, { type: 'block-start', cmd: event.cmd, cwd: event.cwd });
      } else {
        broadcast(session, { type: 'block-end', exit: event.exit, durationMs: event.durationMs });
        pushCtx(session);
      }
    }
    session.parseBuffer = session.parseBuffer.slice(found.index + found[0].length);
  }
}

export function getOrCreateSession(tabId: string, cwd: string = os.homedir()): Session {
  const existing = sessions.get(tabId);
  if (existing) return existing;

  const userShell = process.env.SHELL ?? '/bin/zsh';
  const isZsh = userShell.endsWith('zsh');
  let command: string;
  let args: string[];
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };

  if (isZsh) {
    env.ZDOTDIR = ensureShellInitDir();
  }

  if (isTmuxAvailable()) {
    const overrides: Record<string, string> = {};
    if (env.ZDOTDIR) overrides.ZDOTDIR = env.ZDOTDIR;
    ensureSession(tabId, cwd, overrides);
    command = 'tmux';
    args = attachArgs(tabId);
  } else {
    command = userShell;
    args = [];
  }

  const term = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd,
    env,
  });

  const session: Session = {
    tabId,
    pty: term,
    cols: 200,
    rows: 50,
    cwd,
    nodeVersion: null,
    env: {},
    subscribers: new Set(),
    rawBuffer: '',
    parseBuffer: '',
    parsedOutputBuffer: '',
  };

  term.onData((data) => {
    session.rawBuffer += data;
    if (session.rawBuffer.length > MAX_BUFFER) session.rawBuffer = session.rawBuffer.slice(-MAX_BUFFER);
    broadcast(session, { type: 'raw', data });
    processChunk(session, data);
  });

  term.onExit(() => {
    for (const sub of session.subscribers) { try { sub.close(); } catch {} }
    sessions.delete(tabId);
  });

  sessions.set(tabId, session);
  return session;
}

export function destroySession(tabId: string): void {
  const s = sessions.get(tabId);
  if (s) {
    try { s.pty.kill(); } catch {}
    sessions.delete(tabId);
  }
  if (isTmuxAvailable()) killSession(tabId);
}

export function writeInput(tabId: string, data: string): void {
  sessions.get(tabId)?.pty.write(data);
}

export function resizeSession(tabId: string, cols: number, rows: number): void {
  const s = sessions.get(tabId);
  if (!s) return;
  try { s.pty.resize(cols, rows); s.cols = cols; s.rows = rows; } catch {}
}

export function subscribe(tabId: string, ws: WSLike, cwd?: string): () => void {
  const s = getOrCreateSession(tabId, cwd);
  s.subscribers.add(ws);
  if (s.parsedOutputBuffer) send(ws, { type: 'output', data: s.parsedOutputBuffer });
  if (s.rawBuffer) send(ws, { type: 'raw', data: s.rawBuffer });
  // Send the current ctx (if any) so the new subscriber's chips populate
  // immediately instead of waiting for the next OSC 7 / env / block-end tick.
  if (s.env && Object.keys(s.env).length > 0) pushCtx(s);
  return () => { s.subscribers.delete(ws); };
}

export function sessionCwd(tabId: string): string | null {
  return sessions.get(tabId)?.cwd ?? null;
}

export function sessionNodeVersion(tabId: string): string | null {
  return sessions.get(tabId)?.nodeVersion ?? null;
}

export function sessionEnv(tabId: string): Record<string, string> {
  return sessions.get(tabId)?.env ?? {};
}
