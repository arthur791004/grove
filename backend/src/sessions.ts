import * as pty from 'node-pty';
import os from 'node:os';
import { ensureShellInitDir } from './shellInit.js';
import { findRepoRoot, safeRun, shortPath } from './gitUtil.js';
import { loadBlocks, saveBlocks, deleteBlocks, BlockRecord } from './blockStore.js';
import { getPr } from './prLookup.js';

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
  // Latest observed terminal mode state from the pty stream. Tracked
  // explicitly because rawBuffer is a rolling 200KB window — the original
  // ?1049h/?25l that put a long-running TUI (claude) into raw mode rolls
  // out of the buffer, so the frontend can't infer raw state from rawBuffer
  // alone on reattach.
  altScreen: boolean;
  cursorHide: boolean;
  parseBuffer: string;
  parsedOutputBuffer: string;
  blocks: BlockRecord[];
  currentBlock: BlockRecord | null;
  agentState: AgentState | null;
  agentReply: string | null;
  agentPrompt: AgentPrompt | null;
}

export type AgentState = 'working' | 'blocked';

// One pickable answer. `label` is what the user sees; `send` is what gets
// written to the pty (without the trailing CR) when the choice is picked —
// a digit for numbered menus, `y` / `n` for inline yes/no prompts.
export interface AgentPromptChoice {
  label: string;
  send: string;
}

// When Claude pauses on a numbered permission menu — or any inline `(y/n)`
// prompt — we surface the question + choices so the agents footer can render
// clickable buttons. `null` while Claude is working / idle, or when the
// prompt couldn't be parsed.
export interface AgentPrompt {
  question: string;
  choices: AgentPromptChoice[];
}

const MAX_BLOCKS = 200;
const MAX_BLOCK_OUTPUT = 200_000;

const sessions = new Map<string, Session>();
const MAX_BUFFER = 200_000;

// Tracks alt-screen and cursor-hide toggles for reconnect-time raw-mode
// detection. Includes legacy ?47/?1047 alongside ?1049 so the frontend's
// raw-mode hint covers the same TUIs detectRawScan does.
const ALT_TOGGLE_RE = /\x1b\[\?(?:1049|1047|47)([hl])/g;
const CURSOR_TOGGLE_RE = /\x1b\[\?25([hl])/g;
function updateRawModeState(session: Session, data: string): void {
  // Hot path — skip the two regex scans on chunks with no private-mode
  // sequences (most plain command output).
  if (data.indexOf('\x1b[?') === -1) return;
  for (const m of data.matchAll(ALT_TOGGLE_RE)) session.altScreen = m[1] === 'h';
  for (const m of data.matchAll(CURSOR_TOGGLE_RE)) session.cursorHide = m[1] === 'l';
}

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
    if (session.currentBlock) {
      session.currentBlock.output += s;
      if (session.currentBlock.output.length > MAX_BLOCK_OUTPUT) {
        session.currentBlock.output = session.currentBlock.output.slice(-MAX_BLOCK_OUTPUT);
      }
    }
    broadcast(session, { type: 'output', data: s });
  }
  if (text.indexOf('\x1b') === -1) {
    pushOutput(text);
    return;
  }
  let rest = text;
  while (true) {
    const m = CLEAR_SEQ.exec(rest);
    if (!m) break;
    pushOutput(sanitize(rest.slice(0, m.index)));
    session.parsedOutputBuffer = '';
    // Full wipe — drop completed blocks AND the in-flight one (the `clear`
    // command itself). The subsequent grove-post marker will arrive with no
    // currentBlock and process as a no-op.
    session.blocks = [];
    session.currentBlock = null;
    saveBlocks(session.tabId, session.blocks);
    broadcast(session, { type: 'clear' });
    rest = rest.slice(m.index + m[0].length);
  }
  pushOutput(sanitize(rest));
}

interface BlockPre {
  kind: 'pre';
  cmd: string;
  cwd: string;
}
interface BlockPost {
  kind: 'post';
  exit: number;
  durationMs: number;
}
type BlockEvent = BlockPre | BlockPost;

function send(ws: WSLike, payload: unknown) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {}
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
  let pr: ReturnType<typeof getPr> = null;
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
    if (branch) {
      // PR lookup is async — returns whatever's cached now, fires a refresh
      // in the background, and calls back to re-push ctx when the result
      // actually changes.
      pr = getPr(repoRoot, branch, () => pushCtx(session));
    }
  }
  return {
    cwd,
    shortCwd: sCwd,
    repoRoot: repoRoot ? shortPath(repoRoot) : null,
    branch,
    diff,
    pr,
    node: session.nodeVersion,
    env: session.env,
    cwdReady: true,
  };
}

function pushCtx(session: Session) {
  const existing = ctxDebounce.get(session.tabId);
  if (existing) clearTimeout(existing);
  ctxDebounce.set(
    session.tabId,
    setTimeout(() => {
      ctxDebounce.delete(session.tabId);
      if (!sessions.has(session.tabId)) return;
      try {
        const ctx = buildCtx(session);
        broadcast(session, { type: 'ctx', ctx });
      } catch (err) {
        console.error('[grove] failed to build ctx', err);
      }
    }, 150),
  );
}

function broadcast(session: Session, payload: unknown) {
  for (const sub of session.subscribers) send(sub, payload);
}

function decodeMarker(kind: 'pre' | 'post', body: string): BlockEvent | null {
  if (kind === 'pre') {
    const [b64, ...cwdParts] = body.split(';');
    const cwd = cwdParts.join(';');
    let cmd = '';
    try {
      cmd = Buffer.from(b64, 'base64').toString('utf8');
    } catch {}
    return { kind: 'pre', cmd, cwd };
  } else {
    const [exitStr, durStr] = body.split(';');
    const exit = parseInt(exitStr, 10);
    const dur = parseFloat(durStr) * 1000;
    return {
      kind: 'post',
      exit: Number.isFinite(exit) ? exit : 0,
      durationMs: Number.isFinite(dur) ? dur : 0,
    };
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
        const rec: BlockRecord = {
          cmd: event.cmd,
          cwd: event.cwd,
          output: '',
          exit: null,
          durationMs: null,
        };
        session.blocks.push(rec);
        if (session.blocks.length > MAX_BLOCKS) session.blocks.shift();
        session.currentBlock = rec;
        broadcast(session, { type: 'block-start', cmd: event.cmd, cwd: event.cwd });
      } else {
        if (session.currentBlock) {
          session.currentBlock.exit = event.exit;
          session.currentBlock.durationMs = event.durationMs;
          session.currentBlock = null;
          saveBlocks(session.tabId, session.blocks);
        }
        setAgent(session, null, null, null);
        broadcast(session, { type: 'block-end', exit: event.exit, durationMs: event.durationMs });
        pushCtx(session);
      }
    }
    session.parseBuffer = session.parseBuffer.slice(found.index + found[0].length);
  }
}

function isClaudeSession(session: Session): boolean {
  const cmd = session.currentBlock?.cmd;
  if (!cmd) return false;
  // Match `claude`, `claude --resume`, `npx claude`, etc. Avoids picking up
  // unrelated commands that happen to contain the word.
  return /(?:^|\s)claude(?:\s|$)/.test(cmd);
}

function setAgent(
  session: Session,
  next: AgentState | null,
  reply: string | null,
  prompt: AgentPrompt | null,
): void {
  const sameState = session.agentState === next;
  const sameReply = session.agentReply === reply;
  const samePrompt = agentPromptsEqual(session.agentPrompt, prompt);
  if (sameState && sameReply && samePrompt) return;
  session.agentState = next;
  session.agentReply = reply;
  session.agentPrompt = prompt;
  broadcast(session, { type: 'agent-state', state: next, reply, prompt });
}

function agentPromptsEqual(a: AgentPrompt | null, b: AgentPrompt | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.question !== b.question) return false;
  if (a.choices.length !== b.choices.length) return false;
  for (let i = 0; i < a.choices.length; i++) {
    if (a.choices[i].label !== b.choices[i].label) return false;
    if (a.choices[i].send !== b.choices[i].send) return false;
  }
  return true;
}

// Pull the permission question + numbered choices out of the Claude TUI tail
// when state is `blocked`. Claude renders these as something like:
//
//   ╭─────────────────────────────╮
//   │ Do you want to make this    │
//   │ edit to foo.ts?             │
//   │                             │
//   │ ❯ 1. Yes                    │
//   │   2. Yes, and don't ask     │
//   │     again this session      │
//   │   3. No (esc)               │
//   ╰─────────────────────────────╯
//
// Boxed lines have leading `│ ` / trailing ` │` decoration that we strip. We
// look for the cluster of `<n>. <text>` lines and treat any non-empty lines
// above them (within the same box) as the question.
const PROMPT_CHOICE_RE = /^\s*[❯>]?\s*(\d+)\.\s+(.+?)\s*$/;
const BOX_BORDER_RE = /^[\s│╭╮╰╯─┌┐└┘├┤]*$/;
const PROMPT_QUESTION_MAX_LEN = 240;
const PROMPT_CHOICE_MAX_LEN = 80;
// Inline confirmations that aren't a numbered menu — `Continue? (y/n)`,
// `Overwrite? [Y/n]`, etc. Tolerates `yes`/`no` spelled out and either order.
const YES_NO_RE = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/i;
const NO_YES_RE = /[([]\s*n(?:o)?\s*\/\s*y(?:es)?\s*[)\]]/i;

function extractAgentPrompt(session: Session): AgentPrompt | null {
  if (!isClaudeSession(session)) return null;
  const buf = session.rawBuffer;
  const rawTail = buf.length > DETECT_TAIL ? buf.slice(-DETECT_TAIL) : buf;
  const tail = rawTail.replace(SGR_RE, '');
  // Split into trimmed text lines, stripping the box-drawing decoration.
  const lines = tail
    .split(/\r?\n/)
    .map((l) =>
      l
        // Drop leading/trailing box pipes.
        .replace(/^[\s│]+/, '')
        .replace(/[\s│]+$/, ''),
    );
  // Walk bottom-up to find the most recent contiguous run of numbered choices.
  let endIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_CHOICE_RE.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return extractYesNoPrompt(lines);
  let startIdx = endIdx;
  const choicesRev: Array<{ n: number; text: string }> = [];
  for (let i = endIdx; i >= 0; i--) {
    const m = lines[i].match(PROMPT_CHOICE_RE);
    if (m) {
      choicesRev.push({ n: Number(m[1]), text: m[2] });
      startIdx = i;
    } else if (lines[i] === '' || BOX_BORDER_RE.test(lines[i])) {
      // Allow blank / border lines interleaved with choices that wrap.
      continue;
    } else {
      break;
    }
  }
  if (choicesRev.length === 0) return null;
  const choices: AgentPromptChoice[] = choicesRev.reverse().map((c) => ({
    label:
      c.text.length > PROMPT_CHOICE_MAX_LEN
        ? c.text.slice(0, PROMPT_CHOICE_MAX_LEN - 1) + '…'
        : c.text,
    // Send the digit Claude printed, not the array index — keeps the keypress
    // correct even if the run of choices doesn't start at 1.
    send: String(c.n),
  }));
  // Question = the non-empty text lines above the choices, up to the previous
  // box border / blank gap. Join multi-line wraps with a single space.
  const questionParts: string[] = [];
  for (let i = startIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === '' || BOX_BORDER_RE.test(line)) {
      if (questionParts.length > 0) break;
      continue;
    }
    questionParts.unshift(line);
  }
  let question = questionParts.join(' ').replace(/\s+/g, ' ').trim();
  if (!question) return null;
  if (question.length > PROMPT_QUESTION_MAX_LEN) {
    question = question.slice(0, PROMPT_QUESTION_MAX_LEN - 1) + '…';
  }
  return { question, choices };
}

// Fallback for prompts that aren't a numbered menu: an inline `(y/n)`
// confirmation. The question is the line carrying the marker plus any
// wrapped text above it (stopping at a blank line / box border).
function extractYesNoPrompt(lines: string[]): AgentPrompt | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || (!YES_NO_RE.test(line) && !NO_YES_RE.test(line))) continue;
    const parts = [line];
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j] === '' || BOX_BORDER_RE.test(lines[j])) break;
      parts.unshift(lines[j]);
    }
    let question = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (question.length > PROMPT_QUESTION_MAX_LEN) {
      question = question.slice(0, PROMPT_QUESTION_MAX_LEN - 1) + '…';
    }
    return {
      question,
      choices: [
        { label: 'Yes', send: 'y' },
        { label: 'No', send: 'n' },
      ],
    };
  }
  return null;
}

// Pull a one-line snippet from Claude's most recent assistant turn so the
// agents footer can hint at what was last said. Claude prints assistant text
// with a `⏺ ` bullet; we find the last bullet in the sanitized buffer (which
// keeps SGR but drops cursor moves), grab its line, and strip color codes.
const SGR_RE = /\x1b\[[0-9;]*m/g;
const REPLY_BULLET = '⏺ ';
const REPLY_MAX_LEN = 160;
function extractLastReply(session: Session): string | null {
  if (!isClaudeSession(session)) return null;
  const buf = session.parsedOutputBuffer;
  const tail = buf.length > DETECT_TAIL ? buf.slice(-DETECT_TAIL) : buf;
  const idx = tail.lastIndexOf(REPLY_BULLET);
  if (idx === -1) return null;
  const after = tail.slice(idx + REPLY_BULLET.length);
  const nl = after.indexOf('\n');
  const raw = nl === -1 ? after : after.slice(0, nl);
  const line = raw.replace(SGR_RE, '').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > REPLY_MAX_LEN ? line.slice(0, REPLY_MAX_LEN - 1) + '…' : line;
}

// Derive agent state from the most recent Claude TUI repaint. The marker
// with the highest byte offset in the tail wins — whatever Claude painted
// last. SGR is stripped first because Claude styles individual glyphs (e.g.
// `\x1b[1m❯\x1b[0m 1.`), which breaks literal substring matching otherwise.
const WORKING_MARK = 'esc to interrupt';
const PERMISSION_MARKS = ['Do you want', '❯ 1.', '1. Yes', '(y/n)', '[y/n]'];
const IDLE_MARK = '│ >';
// Tail size is bounded by the size of a single prompt frame (~1–2KB) plus
// some slack. Bigger windows just waste regex work on every pty chunk.
const DETECT_TAIL = 4_096;

function detectAgentState(session: Session): AgentState | null {
  if (!isClaudeSession(session)) return null;
  const buf = session.rawBuffer;
  const rawTail = buf.length > DETECT_TAIL ? buf.slice(-DETECT_TAIL) : buf;
  const tail = rawTail.replace(SGR_RE, '');
  const working = tail.lastIndexOf(WORKING_MARK);
  let blocked = tail.lastIndexOf(IDLE_MARK);
  for (const m of PERMISSION_MARKS) {
    const i = tail.lastIndexOf(m);
    if (i > blocked) blocked = i;
  }
  if (working === -1 && blocked === -1) return session.agentState;
  if (working > blocked) return 'working';
  if (blocked > working) return 'blocked';
  return session.agentState;
}

// Cap concurrent pty sessions to stay well under macOS's kern.tty.ptmx_max
// (default ~127). Hitting forkpty(3) at the OS limit produces the cryptic
// "Could not create a new process and open a pseudo-tty" error and can wedge
// the system shell when other apps need ptys too.
const DEFAULT_MAX_SESSIONS = 64;
export const MAX_SESSIONS = Math.max(
  1,
  Number(process.env.GROVE_MAX_PTY_SESSIONS) || DEFAULT_MAX_SESSIONS,
);

export class SessionLimitError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`pty session limit reached (${limit}); close existing tabs before opening more`);
    this.name = 'SessionLimitError';
    this.limit = limit;
  }
}

export function sessionCount(): number {
  return sessions.size;
}

export function getOrCreateSession(tabId: string, cwd: string = os.homedir()): Session {
  const existing = sessions.get(tabId);
  if (existing) return existing;
  if (sessions.size >= MAX_SESSIONS) throw new SessionLimitError(MAX_SESSIONS);

  const userShell = process.env.SHELL ?? '/bin/zsh';
  const isZsh = userShell.endsWith('zsh');
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (isZsh) env.ZDOTDIR = ensureShellInitDir();

  const term = pty.spawn(userShell, [], {
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
    altScreen: false,
    cursorHide: false,
    parseBuffer: '',
    parsedOutputBuffer: '',
    blocks: loadBlocks(tabId),
    currentBlock: null,
    agentState: null,
    agentReply: null,
    agentPrompt: null,
  };

  term.onData((data) => {
    session.rawBuffer += data;
    if (session.rawBuffer.length > MAX_BUFFER)
      session.rawBuffer = session.rawBuffer.slice(-MAX_BUFFER);
    updateRawModeState(session, data);
    broadcast(session, { type: 'raw', data });
    processChunk(session, data);
    const nextState = detectAgentState(session);
    const nextReply = nextState ? extractLastReply(session) : null;
    const nextPrompt = nextState === 'blocked' ? extractAgentPrompt(session) : null;
    setAgent(session, nextState, nextReply, nextPrompt);
  });

  term.onExit(() => {
    for (const sub of session.subscribers) {
      try {
        sub.close();
      } catch {}
    }
    sessions.delete(tabId);
  });

  sessions.set(tabId, session);
  return session;
}

// Window before we escalate from SIGHUP → SIGKILL. The shell normally dies
// on HUP within a few ms; the timeout only matters when a foreground child
// (claude, vim, node, ssh) traps or ignores HUP — without escalation the pty
// master fd stays allocated and we eventually exhaust kern.tty.ptmx_max.
const KILL_ESCALATE_MS = 500;

export function destroySession(tabId: string): void {
  const s = sessions.get(tabId);
  if (!s) {
    deleteBlocks(tabId);
    return;
  }
  // Remove from the map first so the onExit handler we wired in
  // getOrCreateSession can't race with us and try to clean up twice.
  sessions.delete(tabId);
  for (const sub of s.subscribers) {
    try {
      sub.close();
    } catch {}
  }
  s.subscribers.clear();
  try {
    s.pty.kill('SIGHUP');
  } catch {}
  setTimeout(() => {
    try {
      // kill -0 throws ESRCH if the process is already gone — in that case
      // there's nothing to escalate to and node-pty has already closed the
      // master fd via its own onExit.
      process.kill(s.pty.pid, 0);
      try {
        s.pty.kill('SIGKILL');
      } catch {}
    } catch {}
  }, KILL_ESCALATE_MS).unref();
  deleteBlocks(tabId);
}

export function writeInput(tabId: string, data: string): void {
  sessions.get(tabId)?.pty.write(data);
}

export function resizeSession(tabId: string, cols: number, rows: number): void {
  const s = sessions.get(tabId);
  if (!s) return;
  try {
    s.pty.resize(cols, rows);
    s.cols = cols;
    s.rows = rows;
  } catch {}
}

export function subscribe(tabId: string, ws: WSLike, cwd?: string): () => void {
  let s: Session;
  try {
    s = getOrCreateSession(tabId, cwd);
  } catch (err) {
    if (err instanceof SessionLimitError) {
      send(ws, { type: 'fatal', reason: 'session-limit', message: err.message, limit: err.limit });
      try {
        ws.close();
      } catch {}
      return () => {};
    }
    throw err;
  }
  s.subscribers.add(ws);
  // Tell the frontend whether the session is currently in raw mode BEFORE
  // any replay so it can pre-mount the xterm overlay and hide the blocks
  // list while history streams in. Without this hint, the frontend renders
  // historical block-start/output/block-end first and only flips to raw
  // mode when the live block-start arrives at the end of the replay —
  // producing a visible flash of the blocks list on reattach.
  const rawActive = s.altScreen || s.cursorHide;
  send(ws, { type: 'replay-begin', raw: rawActive });
  // Replay recorded blocks as native block-start/output/block-end triples so
  // a frontend refresh rebuilds the exact same block list it had before.
  for (const b of s.blocks) {
    send(ws, { type: 'block-start', cmd: b.cmd, cwd: b.cwd });
    if (b.output) send(ws, { type: 'output', data: b.output });
    if (b.exit !== null)
      send(ws, { type: 'block-end', exit: b.exit, durationMs: b.durationMs ?? 0 });
  }
  if (s.rawBuffer) send(ws, { type: 'raw', data: s.rawBuffer });
  send(ws, { type: 'replay-end' });
  // Send the current ctx (if any) so the new subscriber's chips populate
  // immediately instead of waiting for the next OSC 7 / env / block-end tick.
  if (s.env && Object.keys(s.env).length > 0) pushCtx(s);
  if (s.agentState)
    send(ws, {
      type: 'agent-state',
      state: s.agentState,
      reply: s.agentReply,
      prompt: s.agentPrompt,
    });
  return () => {
    s.subscribers.delete(ws);
  };
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
