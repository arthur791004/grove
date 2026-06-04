import { useEffect, useLayoutEffect, useMemo, useRef, useState, KeyboardEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Box, HStack, Text } from '@chakra-ui/react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { dispatch } from './extensions/actions';
import { isLocalUrl } from './urlRouting';
import '@xterm/xterm/css/xterm.css';
import { useTabContext, setTabContext, type TabContext } from './useTabContext';
import { useStore, type AgentState, type AgentPrompt } from './store';
import { API_BASE, WS_BASE, sendSessionInput } from './api';
import { bootstrapClaude } from './claudeLaunch';
import { TerminalOutput } from './TerminalOutput';
import { LazyMount } from './LazyMount';
import { SquareLoader } from './SquareLoader';
import { PinBar } from './PinBar';
import { MobileKeyBar } from './MobileKeyBar';
import { BranchIcon, DiffIcon, FileIcon, FolderIcon, NodeIcon, PrIcon, ScriptIcon } from './icons';
import { useIsMobile } from './useViewport';
import { Tooltip } from './Tooltip';
import { useWorkspaceVisible } from './layout/visibility';
import { BranchPopoverTrigger } from './BranchPopover';

const ALT_ON = /\x1b\[\?(?:1049|47|1047)h/g;
const ALT_OFF = /\x1b\[\?(?:1049|47|1047)l/g;
const CURS_OFF = /\x1b\[\?25l/g;
const CURS_ON = /\x1b\[\?25h/g;
const ENTER_RAW = /\x1b\[\?(?:1049|47|1047)h|\x1b\[\?25l/;

// When a single PTY chunk carries both the shell's echo of the command line
// and the TUI's own ?25l/?1049h, we want xterm to start clean at the moment
// raw mode is entered — otherwise the echoed `claude` (or whatever the user
// typed) lives in the buffer behind the TUI and peeks through wherever the
// TUI doesn't paint.
function sliceFromRawEnter(data: string): string {
  const m = ENTER_RAW.exec(data);
  return m ? data.slice(m.index) : data;
}

type RawKind = 'alt' | 'cursor';
interface RawTransition {
  on: boolean;
  kind: RawKind;
}

// Scan for the LAST h/l toggle of a given pair. Returns null if neither appears.
function lastToggle(text: string, onRe: RegExp, offRe: RegExp): boolean | null {
  let lastIdx = -1;
  let val: boolean | null = null;
  let m: RegExpExecArray | null;
  onRe.lastIndex = 0;
  while ((m = onRe.exec(text))) {
    if (m.index > lastIdx) {
      lastIdx = m.index;
      val = true;
    }
  }
  offRe.lastIndex = 0;
  while ((m = offRe.exec(text))) {
    if (m.index > lastIdx) {
      lastIdx = m.index;
      val = false;
    }
  }
  return val;
}

interface RawScan {
  alt: boolean | null;
  cursor: boolean | null;
}

function detectRawScan(text: string): RawScan {
  return {
    alt: lastToggle(text, ALT_ON, ALT_OFF),
    cursor: lastToggle(text, CURS_OFF, CURS_ON),
  };
}

interface Props {
  tabId: string;
  active: boolean;
}

const BACKEND_WS = (tabId: string, cwd?: string) =>
  `${WS_BASE}/pty/${tabId}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`;

interface Block {
  id: number;
  cmd: string;
  cwd: string;
  output: string;
  exit: number | null;
  durationMs: number | null;
  startedAt: number;
  interactive?: boolean;
}

let blockCounter = 0;

// Commands that need a full terminal — block view can't represent their UI.
// Matches when one of these appears as a command token (start of string, or
// after a pipe/semicolon/&&/&), so `git log | less` or `cd x && vim` work.
//
// This is a fast-path heuristic. The authoritative signal comes from the
// backend's `tty-mode` event, which polls the pty's termios via the
// `grove-termios` native addon — when a TUI flips ICANON + ISIG both off,
// we know a raw-reading program is in the foreground. The regex stays as a
// 0-latency cover so the xterm overlay mounts on block-start instead of
// 100ms later when the first termios sample lands.
const INTERACTIVE_CMD_RE =
  /(?:^|[|;&]\s*)(?:sudo\s+|env\s+\w+=\S+\s+)*(ssh|mosh|telnet|tmux|screen|nano|vim?|nvim|emacs|less|more|man|top|htop|btop|nload|iftop|python\d*|ipython|node|deno|bun|psql|mysql|mongosh?|redis-cli|sqlite3|gh|gum|claude|fzf|lazygit|tig|k9s|fly|flyctl)\b/;
function isInteractiveCmd(cmd: string): boolean {
  return INTERACTIVE_CMD_RE.test(cmd.trim());
}

// Mark the tab unread and (once per away-period) bounce the dock. Skipped
// when the user is already looking at this tab — main also coalesces, but
// avoiding the IPC round-trip is cheaper.
function notifyTabAttention(tabId: string): void {
  const st = useStore.getState();
  // AgentsView covers the workspace, so even when this tab is "active" the
  // user is not actually looking at the terminal. Treat that as away.
  const visibleHere = st.activeTabId === tabId && document.hasFocus() && !st.agentsViewOpen;
  if (visibleHere) return;
  const alreadyUnread = !!st.unreadTabs[tabId];
  st.markTabUnread(tabId);
  if (!alreadyUnread) window.grove?.notifyAttention?.();
}

const LONG_CMD_THRESHOLD_MS = 30_000;
function maybeNotifyLongCommand(tabId: string, durationMs: number | null): void {
  if (durationMs === null || durationMs < LONG_CMD_THRESHOLD_MS) return;
  notifyTabAttention(tabId);
}

// Bounce on transitions into a "needs human" state: hit a permission prompt
// (→ blocked) or finished working and dropped back to the input (working → null).
// On entering `blocked` also raise an actionable desktop notification — its
// buttons answer Claude's prompt without the user switching to the tab.
function maybeNotifyAgentWaiting(
  tabId: string,
  prev: AgentState | undefined,
  next: AgentState | null,
  prompt: AgentPrompt | null,
): void {
  if (next === 'blocked' || (prev === 'working' && next === null)) {
    notifyTabAttention(tabId);
  }
  if (next !== 'blocked' || prev === 'blocked') return;
  const st = useStore.getState();
  // Same "can't currently see it" gate as notifyTabAttention.
  if (st.activeTabId === tabId && document.hasFocus() && !st.agentsViewOpen) return;
  const tab = st.tabs.find((t) => t.id === tabId);
  const group = tab && st.groups.find((g) => g.id === tab.groupId);
  window.grove?.notifyBlocked?.({
    tabId,
    title: 'Claude needs your input',
    workspace: group?.name ?? '',
    question: prompt?.question ?? 'Claude is waiting for your response.',
    choices: (prompt?.choices ?? []).map((c) => ({ label: c.label, send: c.send })),
  });
}

interface CompletionItem {
  value: string;
  label: string;
  kind: 'dir' | 'file' | 'branch' | 'script';
}

let serverCompletionsCache: string[] = [];
let shellHistoryCache: string[] = [];
let serverCompletionsFetchedAt = 0;
const completionsListeners = new Set<(h: string[]) => void>();
async function fetchServerCompletions(
  force = false,
): Promise<{ completions: string[]; history: string[] }> {
  if (!force && Date.now() - serverCompletionsFetchedAt < 30_000 && serverCompletionsCache.length) {
    return { completions: serverCompletionsCache, history: shellHistoryCache };
  }
  try {
    const res = await fetch(API_BASE + '/completions');
    const data = await res.json();
    serverCompletionsCache = Array.isArray(data.completions) ? data.completions : [];
    shellHistoryCache = Array.isArray(data.history) ? data.history : [];
    serverCompletionsFetchedAt = Date.now();
    for (const fn of completionsListeners) fn(shellHistoryCache);
  } catch {}
  return { completions: serverCompletionsCache, history: shellHistoryCache };
}

async function appendShellHistory(cmd: string) {
  const trimmed = cmd.trim();
  if (!trimmed) return;
  try {
    await fetch(API_BASE + '/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: trimmed }),
    });
    // Force-refresh so other tabs (and ArrowUp in this tab) immediately see
    // the just-submitted command in shell history.
    fetchServerCompletions(true);
  } catch {}
}

const MAX_BLOCK_OUTPUT = 200_000;
const capOutput = (s: string): string =>
  s.length > MAX_BLOCK_OUTPUT ? s.slice(-MAX_BLOCK_OUTPUT) : s;

function useCmdHeld(): boolean {
  const [down, setDown] = useState(false);
  useEffect(() => {
    const onDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') setDown(true);
    };
    const onUp = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') setDown(false);
    };
    const onBlur = () => setDown(false);
    document.addEventListener('keydown', onDown);
    document.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onDown);
      document.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return down;
}

// Matches git's "fatal: 'main' is already used by worktree at '/path'" so
// the renderer can replace git's wall-of-text with a workspace-aware hint.
const FORK_LOCK_RE = /fatal: '([^']+)' is already (?:checked out|used by worktree) at/;


function applyCarriageReturns(prev: string, incoming: string): string {
  if (
    incoming.indexOf('\r') === -1 &&
    incoming.indexOf('\n') === -1 &&
    incoming.indexOf('\x1b[') === -1
  ) {
    return prev + incoming;
  }

  let result = prev;
  let pending = '';
  const flush = () => {
    if (pending) {
      result += pending;
      pending = '';
    }
  };
  const killCurrentLine = () => {
    flush();
    const nl = result.lastIndexOf('\n');
    result = nl === -1 ? '' : result.slice(0, nl + 1);
  };
  const popLines = (n: number) => {
    flush();
    for (let k = 0; k < n; k++) {
      // If the cursor is mid-line (no trailing \n), first drop that partial line.
      if (!result.endsWith('\n')) {
        const nl = result.lastIndexOf('\n');
        result = nl === -1 ? '' : result.slice(0, nl + 1);
      }
      if (result === '') break;
      // Real-terminal cursor-up + overwrite is approximated by dropping the
      // previous line entirely so subsequent writes append fresh content.
      result = result.slice(0, -1); // drop trailing \n
      const nl = result.lastIndexOf('\n');
      result = nl === -1 ? '' : result.slice(0, nl + 1);
    }
  };

  let i = 0;
  while (i < incoming.length) {
    const ch = incoming[i];
    if (ch === '\r') {
      if (incoming[i + 1] === '\n') {
        flush();
        result += '\n';
        i += 2;
      } else {
        killCurrentLine();
        i++;
      }
    } else if (ch === '\n') {
      flush();
      result += '\n';
      i++;
    } else if (ch === '\x1b' && incoming[i + 1] === '[') {
      let j = i + 2;
      while (j < incoming.length && /[0-9;?]/.test(incoming[j])) j++;
      if (j >= incoming.length) {
        pending += ch;
        i++;
        continue;
      }
      const param = incoming.slice(i + 2, j);
      const fin = incoming[j];
      const seq = incoming.slice(i, j + 1);
      i = j + 1;
      if (fin === 'A' || fin === 'F') {
        const n = param === '' ? 1 : parseInt(param, 10) || 1;
        popLines(n);
        if (fin === 'F') killCurrentLine();
      } else if (fin === 'K') {
        const mode = param === '' ? 0 : parseInt(param, 10);
        if (mode === 0 || mode === 2) killCurrentLine();
      } else if (fin === 'J') {
        const mode = param === '' ? 0 : parseInt(param, 10);
        if (mode === 0 || mode === 2) killCurrentLine();
      } else {
        // SGR or other zero-width — pass through to preserve colors.
        pending += seq;
      }
    } else {
      pending += ch;
      i++;
    }
  }
  flush();
  return result;
}

// Tallest the prompt textarea grows before it scrolls internally (~10 lines).
const MAX_INPUT_HEIGHT = 220;
// Prompt line height in px — must match the textarea/mirror `lineHeight`.
const INPUT_LINE_HEIGHT = 22;

export function TerminalView({ tabId, active }: Props) {
  // The workspace this TerminalView lives in may be parked under
  // display:none while another workspace is in front. ResizeObserver fires
  // a frame too late on visible→hidden→visible, so we also drive a refit
  // off this context value.
  const workspaceVisible = useWorkspaceVisible();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  // The text the user had typed when they started walking history. Restored on
  // ArrowDown past the newest match so it feels like fish/zsh substring-search.
  const [historyPrefix, setHistoryPrefix] = useState<string>('');
  const isRunning = useStore((s) => !!s.runningCmds[tabId]);
  const tabKind = useStore((s) => s.tabs.find((t) => t.id === tabId)?.kind);
  const isMobile = useIsMobile();
  const cmdHeld = useCmdHeld();
  const ctx = useTabContext(tabId, 0, 0, active || isRunning);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const currentBlockRef = useRef<number | null>(null);
  const [caretLeft, setCaretLeft] = useState(0);
  const [caretTop, setCaretTop] = useState(0);
  const [caretVisible, setCaretVisible] = useState(true);
  const [altScreen, setAltScreen] = useState(false);
  const [cursorHide, setCursorHide] = useState(false);
  const [forcedRaw, setForcedRaw] = useState(false);
  // Mirrors backend's termios poll: true when the foreground program has
  // turned the pty into raw mode (ICANON + ISIG both off). Cleared at
  // block-end like the other raw flags so a TUI that exits without emitting
  // ?1049l / ?25h doesn't leave the overlay stuck.
  const [ttyRaw, setTtyRaw] = useState(false);
  // Pre-mounts the xterm overlay during subscribe replay when the backend
  // tells us the session is currently in raw mode (long-running TUI like
  // claude). Cleared on `replay-end` once the live raw stream has taken
  // over. Without this, historical block replay flashes the blocks list
  // before the live block-start flips into raw mode.
  const [replayRaw, setReplayRaw] = useState(false);
  // Full-component loading overlay shown from mount until the subscribe
  // replay finishes (replay-end). Keeps users from seeing an empty xterm
  // or a flash of stale blocks while history streams in. Safety timeout
  // covers older daemons that don't emit replay-begin/end.
  const [loading, setLoading] = useState(true);
  const loadingTimerRef = useRef<number | null>(null);
  // Surfaced when git refuses a branch switch because another worktree owns
  // the branch. Dismissed by the user or auto-cleared on the next block start.
  const [forkLockHint, setForkLockHint] = useState<{ branch: string } | null>(null);
  const rawMode = altScreen || cursorHide || forcedRaw || ttyRaw || replayRaw;
  const rawKind: RawKind = altScreen || forcedRaw || ttyRaw ? 'alt' : 'cursor';
  const rawModeRef = useRef(false);
  // True while the backend is streaming captured raw history on reattach.
  // During this window xterm fields any terminal queries the remote sent
  // originally (DA, CPR, OSC 11 background-color, …) and emits auto-replies
  // through term.onData. The remote already got its answers ages ago, so
  // forwarding the replies now paints garbage like `;rgb:.../...;R` into the
  // shell's input buffer.
  const replayRawRef = useRef(false);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const inPromptRef = useRef(true);
  const xtermHostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const altCarryRef = useRef<string>('');
  const pendingOutputRef = useRef<Map<number, string>>(new Map());
  const flushRafRef = useRef<number | null>(null);

  // Snapshot the currently-active xterm buffer as plain text. Used when raw
  // mode exits so the resulting block keeps a record of what the user saw —
  // matches Warp's "collapsed block per TUI run" behavior. Must be called
  // BEFORE writing the sequence that ends raw mode (?1049l switches xterm
  // back to the normal buffer, discarding the alt-screen contents).
  function snapshotXtermBuffer(): string {
    const term = xtermRef.current;
    const ser = serializeRef.current;
    if (!term || !ser) return '';
    // Serialize only the visible viewport rows — that's what the user actually
    // saw. Including scrollback would prepend stale shell history for normal-
    // buffer apps (claude, ssh prompts) that don't switch to the alt screen.
    const text = ser.serialize({ scrollback: 0 });
    const lines = text.split('\n');
    while (lines.length && lines[lines.length - 1].replace(/\x1b\[[^m]*m/g, '') === '') lines.pop();
    return lines.join('\n');
  }
  function applySnapshotToInteractiveBlock(text: string) {
    if (!text) return;
    const cur = currentBlockRef.current;
    setBlocks((bs) => {
      if (cur !== null) {
        return bs.map((b) => (b.id === cur ? { ...b, output: capOutput(text) } : b));
      }
      for (let i = bs.length - 1; i >= 0; i--) {
        if (bs[i].interactive) {
          return bs.map((b, idx) => (idx === i ? { ...b, output: capOutput(text) } : b));
        }
      }
      return bs;
    });
  }

  function flushPendingOutput() {
    flushRafRef.current = null;
    const snapshot = pendingOutputRef.current;
    if (snapshot.size === 0) return;
    pendingOutputRef.current = new Map();
    // The updater must be pure — React 18 StrictMode double-invokes it in
    // dev, so we can't mutate `snapshot` (e.g. .delete) here.
    setBlocks((bs) =>
      bs.map((b) => {
        const chunk = snapshot.get(b.id);
        if (!chunk) return b;
        return { ...b, output: capOutput(applyCarriageReturns(b.output, chunk)) };
      }),
    );
  }
  function scheduleFlush() {
    if (flushRafRef.current !== null) return;
    flushRafRef.current = requestAnimationFrame(flushPendingOutput);
  }

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (closed) return;
      const st = useStore.getState();
      const tab = st.tabs.find((t) => t.id === tabId);
      const group = tab ? st.groups.find((g) => g.id === tab.groupId) : null;
      const ws = new WebSocket(BACKEND_WS(tabId, group?.cwd));
      wsRef.current = ws;
      // Don't reset `attempt` until the socket has stayed up long enough to
      // suggest it's actually healthy. Resetting in onopen lets the server
      // (e.g., session-limit reject) loop us forever: open → close → open →
      // close, with attempt back to 0 every cycle.
      let stableTimer: ReturnType<typeof setTimeout> | null = null;
      ws.onopen = () => {
        // Sync the PTY to xterm's CURRENT size. On a reconnect (e.g. a phone
        // returning from another app) the server-side PTY already holds the
        // right dimensions — sending xterm's real size is a no-op, whereas the
        // old hardcoded 200×50 forced a SIGWINCH that reflowed a running TUI
        // every app-switch. Pre-fit xterm reports its 80×24 default; that
        // first-connect reflow stays hidden behind the loading overlay.
        const term = xtermRef.current;
        ws.send(
          JSON.stringify({ type: 'resize', cols: term?.cols ?? 200, rows: term?.rows ?? 50 }),
        );
        // Clear stale readline buffer pollution (Ctrl-U = kill-whole-line) —
        // but only in cooked/shell mode. In raw mode this is a live keystroke
        // into the TUI; on a reconnect it would wipe whatever the user had
        // typed into Claude's prompt.
        if (!rawModeRef.current) ws.send(JSON.stringify({ type: 'input', data: '\x15' }));
        stableTimer = setTimeout(() => {
          attempt = 0;
          stableTimer = null;
        }, 3000);
        // Safety net: if replay-end never arrives (older daemon without the
        // replay envelope, or a stalled connection), drop the loader so the
        // UI isn't permanently masked.
        if (loadingTimerRef.current !== null) clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = window.setTimeout(() => {
          setLoading(false);
          loadingTimerRef.current = null;
        }, 1500);
      };
      ws.onclose = () => {
        if (stableTimer) {
          clearTimeout(stableTimer);
          stableTimer = null;
        }
        if (closed) return;
        attempt += 1;
        const delay = Math.min(2000, 200 * 2 ** Math.min(attempt - 1, 4));
        if (attempt > 8) {
          console.error(
            `[grove] failed to connect to backend at ${WS_BASE} after multiple attempts`,
          );
          return;
        }
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        /* handled in onclose */
      };
      ws.onmessage = (ev) => {
        // Drop events from a stale socket. React 18 StrictMode runs the effect
        // twice in dev: the first WS subscribes and the backend immediately
        // sends a block replay, which would land in shared component state
        // (refs/setBlocks) and double everything. Cleanup flips `closed=true`
        // so the doomed socket's events get discarded.
        if (closed || ws !== wsRef.current) return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'replay-begin') {
            // If the backend says the session is in raw mode, pre-mount the
            // xterm overlay so the historical block replay that follows is
            // hidden underneath it. replay-end clears the flag once the
            // live raw stream has reconstructed the TUI.
            if (msg.raw) setReplayRaw(true);
            replayRawRef.current = true;
            return;
          }
          if (msg.type === 'replay-end') {
            setReplayRaw(false);
            replayRawRef.current = false;
            setLoading(false);
            if (loadingTimerRef.current !== null) {
              clearTimeout(loadingTimerRef.current);
              loadingTimerRef.current = null;
            }
            // Drain-on-consume so reconnects don't re-fire the bootstrap.
            if (useStore.getState().consumeClaudeBootstrap(tabId)) {
              void bootstrapClaude(tabId);
            }
            return;
          }
          if (msg.type === 'fatal') {
            // Backend rejected the subscription (e.g., session-limit). Don't
            // reconnect — that just loops forever hitting the same reject.
            console.error('[grove] backend fatal:', msg.reason, msg.message);
            closed = true;
            return;
          }
          if (msg.type === 'raw' || msg.type === 'output') {
            const m = typeof msg.data === 'string' ? msg.data.match(FORK_LOCK_RE) : null;
            if (m) setForkLockHint({ branch: m[1] });
          }
          if (msg.type === 'raw') {
            const scan = altCarryRef.current + msg.data;
            const result = detectRawScan(scan);
            const willEnterRaw =
              (result.alt === true || result.cursor === true) && !rawModeRef.current;
            // Compute whether this scan ends raw mode. forcedRaw is handled at
            // block-end, not here, so it's excluded from the projection.
            const nextAlt = result.alt !== null ? result.alt : altScreen;
            const nextCur = result.cursor !== null ? result.cursor : cursorHide;
            const willExitRaw = rawModeRef.current && !nextAlt && !nextCur && !forcedRaw;

            // Capture the alt buffer BEFORE xterm processes ?1049l, otherwise
            // we'd snapshot the restored normal buffer (shell scrollback)
            // instead of what the TUI actually showed.
            let snapshot: string | null = null;
            if (willExitRaw) snapshot = snapshotXtermBuffer();

            if (willEnterRaw) {
              // reset() rebuilds buffers but the visible canvas may carry the
              // pre-trigger paint until the next render tick. Stamp an explicit
              // `\e[2J\e[H` (clear screen + cursor home) so the new write lands
              // on a guaranteed-blank frame.
              xtermRef.current?.reset();
              xtermRef.current?.write('\x1b[2J\x1b[H' + sliceFromRawEnter(msg.data));
              // Flip the ref synchronously so a block-start arriving in the
              // next WS message (before React re-renders rawMode → useEffect →
              // ref) sees raw mode as already active and skips its own reset.
              rawModeRef.current = true;
              // New raw-mode session starts at viewport-top; pin the viewport
              // to bottom so subsequent writes auto-follow. Without this,
              // normal-buffer apps (claude, ssh) leave the viewport offset
              // and wheel-down can't reach the bottom row.
              xtermRef.current?.scrollToBottom();
            } else {
              xtermRef.current?.write(msg.data);
            }

            if (snapshot) applySnapshotToInteractiveBlock(snapshot);

            if (result.alt !== null) setAltScreen(result.alt);
            if (result.cursor !== null) setCursorHide(result.cursor);

            if (willEnterRaw) {
              const cur = currentBlockRef.current;
              if (cur !== null) {
                setBlocks((bs) =>
                  bs.map((b) => (b.id === cur ? { ...b, interactive: true, output: '' } : b)),
                );
              }
            }
            altCarryRef.current = scan.slice(-16);
            return;
          }
          if (msg.type === 'clear') {
            // Full wipe including the in-progress block (the `clear` command
            // itself). The shell's subsequent grove-post arrives with no
            // current block on the frontend — block-end's null-cur branch
            // handles it as a no-op cleanup.
            pendingOutputRef.current.clear();
            currentBlockRef.current = null;
            setBlocks(() => []);
            return;
          }
          if (msg.type === 'output') {
            // Discard output while in raw mode (xterm is live) or at the
            // prompt (it's just PS1, nothing to record in the blocks view).
            if (rawModeRef.current || inPromptRef.current) return;
            const cur = currentBlockRef.current;
            if (cur === null) return;
            // Coalesce output per rAF so spinner-heavy commands (yarn, npm)
            // don't trigger a React render on every emitted frame.
            const pending = pendingOutputRef.current;
            pending.set(cur, (pending.get(cur) ?? '') + msg.data);
            scheduleFlush();
          } else if (msg.type === 'block-start') {
            setForkLockHint(null);
            inPromptRef.current = false;
            const id = ++blockCounter;
            currentBlockRef.current = id;
            const interactive = isInteractiveCmd(msg.cmd ?? '');
            // Commit immediately so slow commands (git pull, npm install) show
            // their card right away instead of looking like nothing happened
            // until the first output chunk lands.
            const pending: Block = {
              id,
              cmd: msg.cmd,
              cwd: msg.cwd,
              output: '',
              exit: null,
              durationMs: null,
              startedAt: Date.now(),
              interactive: interactive || undefined,
            };
            setBlocks((bs) => [...bs.slice(-200), pending]);
            if (interactive) {
              // Only reset xterm if we haven't already entered raw mode via
              // ?25l/?1049h in the raw stream — otherwise we wipe the TUI's
              // already-drawn first frame and the rest of the run only shows
              // delta updates (e.g. the leftover "claude" word from its banner).
              if (!rawModeRef.current) {
                xtermRef.current?.reset();
                xtermRef.current?.write('\x1b[2J\x1b[H');
              }
              setForcedRaw(true);
              rawModeRef.current = true;
              xtermRef.current?.scrollToBottom();
            }
            useStore.getState().setRunningCmd(tabId, msg.cmd || '');
          } else if (msg.type === 'ctx') {
            setTabContext(tabId, msg.ctx);
          } else if (msg.type === 'block-end') {
            // Snapshot xterm before the shell's redraw pollutes it. Covers
            // both forcedRaw exits (commands like `claude` that never emit
            // ?1049h) and any straggler where raw toggles weren't observed
            // before the block ended.
            const snapshot = rawModeRef.current ? snapshotXtermBuffer() : null;
            const cur = currentBlockRef.current;
            if (cur !== null) {
              setBlocks((bs) =>
                bs.map((b) =>
                  b.id === cur ? { ...b, exit: msg.exit, durationMs: msg.durationMs } : b,
                ),
              );
            }
            maybeNotifyLongCommand(tabId, msg.durationMs);
            if (snapshot) applySnapshotToInteractiveBlock(snapshot);
            // Clear xterm so the next interactive command — including ones
            // that don't emit ?25l/?1049h on entry — starts on a blank canvas
            // instead of inheriting the previous TUI's last frame.
            if (rawModeRef.current) {
              xtermRef.current?.reset();
              xtermRef.current?.write('\x1b[2J\x1b[H');
            }
            currentBlockRef.current = null;
            inPromptRef.current = true;
            // The shell is back at its prompt, so no interactive program is
            // running — force every raw-mode flag off, not just forcedRaw.
            // A TUI that exits abnormally (e.g. an ssh session whose
            // connection dropped) never emits its ?1049l / ?25h restore
            // sequence, so altScreen / cursorHide would otherwise stay stuck
            // true and keep the xterm overlay pinned over the block view.
            setForcedRaw(false);
            setAltScreen(false);
            setCursorHide(false);
            setTtyRaw(false);
            altCarryRef.current = '';
            rawModeRef.current = false;
            useStore.getState().setRunningCmd(tabId, null);
          } else if (msg.type === 'tty-mode') {
            // Backend's termios poll says the foreground program has flipped
            // the pty into raw mode (or back out). Only act on the entry
            // edge inside a running block: block-end will tidy the exit.
            const nextRaw = !!msg.raw;
            if (nextRaw && currentBlockRef.current !== null) {
              if (!rawModeRef.current) {
                xtermRef.current?.reset();
                xtermRef.current?.write('\x1b[2J\x1b[H');
              }
              rawModeRef.current = true;
              xtermRef.current?.scrollToBottom();
            }
            setTtyRaw(nextRaw && currentBlockRef.current !== null);
          } else if (msg.type === 'agent-state') {
            const prev = useStore.getState().agentStates[tabId];
            const next: AgentState | null = msg.state ?? null;
            useStore.getState().setAgentState(tabId, next, msg.reply ?? null, msg.prompt ?? null);
            maybeNotifyAgentWaiting(tabId, prev, next, msg.prompt ?? null);
          }
        } catch {}
      };
    }

    connect();

    // Mobile browsers suspend background tabs and silently drop the WS;
    // reconnect immediately when the tab becomes visible again instead of
    // waiting out the exponential backoff.
    const onVisible = () => {
      if (document.hidden || closed) return;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      attempt = 0;
      connect();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (flushRafRef.current !== null) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = null;
      }
      if (loadingTimerRef.current !== null) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      wsRef.current?.close();
    };
  }, [tabId]);

  // Sticky-bottom: track whether the user is pinned to the bottom, and only
  // snap there when they are. While unpinned (the user scrolled up to read
  // history), output streams in without yanking the viewport. With this in
  // place, manual scroll + auto-follow coexist smoothly.
  const isPinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    isPinnedRef.current = atBottom;
    setPinned((prev) => (prev === atBottom ? prev : atBottom));
  };
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && isPinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  useEffect(() => {
    if (!xtermHostRef.current) return;
    const term = new Terminal({
      fontFamily: 'var(--grove-mono), Menlo, monospace',
      fontSize: useStore.getState().monoFontSize,
      theme: { background: '#010409', foreground: '#c9d1d9' },
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    // Cmd/Ctrl-click on a URL inside the live TUI (Claude, ssh prompts, etc.):
    //   - localhost / 127.0.0.1 → embedded browser panel (dev servers, etc.)
    //   - everything else → OS default browser via shell.openExternal.
    const webLinks = new WebLinksAddon((event, uri) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (isLocalUrl(uri)) {
        dispatch('open-url', { url: uri });
      } else {
        window.grove?.openExternal?.(uri);
      }
    });
    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.loadAddon(webLinks);
    term.open(xtermHostRef.current);
    xtermRef.current = term;
    fitRef.current = fit;
    serializeRef.current = serialize;

    // xterm.js mounts a hidden .xterm-helper-textarea that receives all key
    // input. On iOS the soft keyboard's defaults rewrite what the user types:
    // straight quotes become smart quotes, the first letter of a prompt gets
    // capitalized, autocomplete inserts whole words on space. None of that is
    // wanted inside a TUI — Claude's slash menu breaks if "/" gets autoreplaced
    // and a prompt to "fix the bug" arrives as "Fix the bug." Strip all of it
    // at mount; harmless on desktop where these attributes do nothing.
    const helperTa = xtermHostRef.current.querySelector(
      'textarea.xterm-helper-textarea',
    ) as HTMLTextAreaElement | null;
    if (helperTa) {
      helperTa.setAttribute('autocorrect', 'off');
      helperTa.setAttribute('autocapitalize', 'off');
      helperTa.setAttribute('autocomplete', 'off');
      helperTa.setAttribute('spellcheck', 'false');
    }

    term.onData((data) => {
      // Only forward to PTY in raw mode. Otherwise xterm's auto-responses to
      // terminal queries (DA, cursor position, etc.) pollute the input stream.
      if (!rawModeRef.current) return;
      // Suppress auto-replies during reattach replay — see replayRawRef.
      if (replayRawRef.current) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    function doFitAndResize() {
      // Skip while the tab is inactive — Workspace hides it via display:none,
      // which collapses the xterm host to 0×0. fit.fit() would then clamp the
      // PTY down to ~2 cols × 1 row, wrecking any running raw-mode app's
      // alt-screen buffer before the user switches back.
      if (!activeRef.current) return;
      const host = xtermHostRef.current;
      if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {}
      // After a resize the viewport may sit above the new bottom row, leaving
      // a gap that wheel-down can't cross. Re-pin while in raw mode.
      if (rawModeRef.current) xtermRef.current?.scrollToBottom();
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }
    const ro = new ResizeObserver(doFitAndResize);
    ro.observe(xtermHostRef.current);

    // Wheel-near-bottom magnet: when the user scrolls downward inside the
    // xterm viewport and is already within ~3 rows of the buffer's bottom,
    // snap to the actual bottom row. xterm's viewport can otherwise sit on
    // a "phantom" empty row after a resize/redraw, leaving the prompt out
    // of view and forcing the user to press ↓ to bring it back.
    const onWheelMagnet = (ev: WheelEvent) => {
      if (!rawModeRef.current) return;
      if (ev.deltaY <= 0) return;
      const term = xtermRef.current;
      if (!term) return;
      const buf = term.buffer.active;
      const viewportRow = buf.viewportY;
      const lastRow = buf.length - term.rows;
      if (lastRow - viewportRow <= 3) term.scrollToBottom();
    };
    xtermHostRef.current.addEventListener('wheel', onWheelMagnet, { passive: true });

    // Re-measure after fonts load (xterm caches cell width on open).
    const fontsReady = (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready;
    if (fontsReady)
      fontsReady.then(() => {
        // Touching fontFamily forces xterm to flush its cached metrics.
        const fam = term.options.fontFamily;
        term.options.fontFamily = 'monospace';
        term.options.fontFamily = fam;
        doFitAndResize();
      });
    const t1 = setTimeout(doFitAndResize, 100);
    const t2 = setTimeout(doFitAndResize, 500);

    const host = xtermHostRef.current;
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
      host?.removeEventListener('wheel', onWheelMagnet);
      term.dispose();
      xtermRef.current = null;
      serializeRef.current = null;
    };
  }, [tabId]);

  // Apply Settings font preferences live. Selector-driven so these fire only
  // when the actual slice changes (cf. useStore.subscribe, which woke up on
  // every store mutation across every mounted TerminalView).
  const prefFontSize = useStore((s) => s.monoFontSize);
  const prefFontFamily = useStore((s) => s.monoFontFamily);
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.fontSize = prefFontSize;
    try {
      fitRef.current?.fit();
    } catch {
      /* xterm not yet sized */
    }
  }, [prefFontSize]);
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    // Re-set fontFamily to flush xterm's cached cell metrics.
    const fam = term.options.fontFamily;
    term.options.fontFamily = 'monospace';
    term.options.fontFamily = fam;
    try {
      fitRef.current?.fit();
    } catch {
      /* xterm not yet sized */
    }
  }, [prefFontFamily]);

  useEffect(() => {
    rawModeRef.current = rawMode;
  }, [rawMode]);

  // Pinch-to-zoom on the xterm overlay (mobile web only). Two-finger pinch
  // scales monoFontSize, which the effect above pushes into xterm + a refit.
  // When non-raw mode the overlay sits at zIndex -1 + visibility:hidden, so it
  // can't receive touches — safe to keep the listener attached unconditionally
  // on mobile. We must use native touch events with passive:false to suppress
  // the browser's own pinch-zoom.
  useEffect(() => {
    if (!isMobile) return;
    const host = xtermHostRef.current;
    if (!host) return;
    let startDist = 0;
    let startSize = 0;
    let active = false;
    const dist = (a: Touch, b: Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      startDist = dist(e.touches[0], e.touches[1]);
      startSize = useStore.getState().monoFontSize;
      active = startDist > 10;
      if (active) e.preventDefault();
    };
    const onMove = (e: TouchEvent) => {
      if (!active || e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches[0], e.touches[1]);
      const next = Math.round(startSize * (d / startDist));
      const store = useStore.getState();
      if (next !== store.monoFontSize) store.setMonoFontSize(next);
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) active = false;
    };
    host.addEventListener('touchstart', onStart, { passive: false });
    host.addEventListener('touchmove', onMove, { passive: false });
    host.addEventListener('touchend', onEnd);
    host.addEventListener('touchcancel', onEnd);
    return () => {
      host.removeEventListener('touchstart', onStart);
      host.removeEventListener('touchmove', onMove);
      host.removeEventListener('touchend', onEnd);
      host.removeEventListener('touchcancel', onEnd);
    };
  }, [isMobile]);

  useEffect(() => {
    if (active) {
      // Re-sync PTY size whenever the tab becomes active. While hidden via
      // display:none, the xterm host is 0×0 and ResizeObserver fires no useful
      // updates — so if the window was resized while inactive, the PTY is
      // still at the old dimensions until we fit here.
      requestAnimationFrame(() => {
        const t = xtermRef.current;
        const f = fitRef.current;
        const ws = wsRef.current;
        const host = xtermHostRef.current;
        if (t && f && host && host.clientWidth > 0 && host.clientHeight > 0) {
          try {
            f.fit();
          } catch {}
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
          }
        }
        if (rawMode) t?.focus();
        // Focus the prompt textarea even when a block is running: it now
        // doubles as line-buffered stdin for password prompts and the like,
        // so the user can start typing as soon as scp asks.
        else inputRef.current?.focus();
      });
    }
  }, [rawMode, active, isRunning]);

  // Refit on workspace visibility flips. Mirrors the leaf-active effect
  // above for the workspace-level display:none toggle (LayoutContent
  // hides parked workspaces). Also covers the first-mount race: if the
  // initial RO observe fires while host.clientWidth is still 0, no fit
  // ever runs and the PTY sits at xterm's default 80x24 — which is what
  // a TUI like Codex captures when it prints its first block. We retry
  // for ~0.5s until the host actually has a non-zero width.
  useEffect(() => {
    if (!workspaceVisible) return;
    let frames = 0;
    let cancelled = false;
    const tryFit = () => {
      if (cancelled) return;
      const t = xtermRef.current;
      const f = fitRef.current;
      const ws = wsRef.current;
      const host = xtermHostRef.current;
      if (t && f && host && host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          f.fit();
        } catch {}
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
        }
        return;
      }
      if (frames++ < 30) requestAnimationFrame(tryFit);
    };
    requestAnimationFrame(tryFit);
    return () => {
      cancelled = true;
    };
  }, [workspaceVisible]);

  // Grow the prompt textarea with its content up to MAX_INPUT_HEIGHT, after
  // which it scrolls internally.
  function autoGrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
  }

  // The native caret is hidden (caretColor: transparent) so we can draw our
  // own terminal-style block. A hidden mirror div replays the textarea's text
  // and soft-wrapping, letting us read the caret's pixel row + column for any
  // line of a multiline draft.
  function updateCaret() {
    const el = inputRef.current;
    const mirror = mirrorRef.current;
    if (!el || !mirror) return;
    const pos = el.selectionStart ?? el.value.length;
    mirror.style.width = `${el.clientWidth}px`;
    mirror.textContent = el.value.slice(0, pos);
    const marker = document.createElement('span');
    // A zero-width space keeps the span measurable at the start of an empty
    // line (a 0-width empty span still reports the right offsetTop/Left).
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    setCaretLeft(marker.offsetLeft);
    // offsetTop reports the inline-content box, which sits a few px below the
    // line-box top; snap to the line grid so the caret stays line-centered.
    const row = Math.round(marker.offsetTop / INPUT_LINE_HEIGHT);
    setCaretTop(row * INPUT_LINE_HEIGHT - el.scrollTop);
  }

  useEffect(() => {
    autoGrow();
    updateCaret();
  }, [input]);

  // Keep the prompt input focused while this tab is active so the user can
  // just start typing without ever clicking. Triggered on a real "typing" key,
  // and skipped when the user is interacting with another input/textarea,
  // when modifiers are held (so ⌘C / ⌘V / shortcuts still work), or while a
  // running block has the rawMode listener swallowing keys.
  useEffect(() => {
    if (!active) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t === inputRef.current) return;
      if (t && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      // Filter to keys that would actually produce input — printables, space,
      // backspace, enter, etc. Skip pure navigation/function keys so arrows on
      // a focused panel don't yank focus away.
      const k = e.key;
      const isPrintable = k.length === 1;
      const isEditing = k === 'Backspace' || k === 'Enter' || k === 'Tab';
      if (!isPrintable && !isEditing) return;
      inputRef.current?.focus();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);

  // Paste anywhere outside an editable field (e.g. right after selecting text
  // in an output block) lands in the prompt input instead of being dropped.
  // A paste straight into the textarea is left to the browser.
  useEffect(() => {
    if (!active) return;
    function onPaste(e: ClipboardEvent) {
      const el = inputRef.current;
      if (!el || el.readOnly || rawMode) return;
      const t = e.target as HTMLElement | null;
      if (t === el) return;
      if (t && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text) return;
      e.preventDefault();
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      setInput(el.value.slice(0, start) + text + el.value.slice(end));
      setHistoryIndex(null);
      el.focus();
      requestAnimationFrame(() => {
        const caret = start + text.length;
        el.setSelectionRange(caret, caret);
        updateCaret();
      });
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [active, rawMode]);

  function send(data: string) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
  }

  const [serverCompletions, setServerCompletions] = useState<string[]>(serverCompletionsCache);
  const [shellHistory, setShellHistory] = useState<string[]>(shellHistoryCache);
  const [contextual, setContextual] = useState<CompletionItem[]>([]);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchServerCompletions().then(({ completions, history }) => {
      if (cancelled) return;
      setServerCompletions(completions);
      setShellHistory(history);
    });
    // Subscribe so a command submitted in any tab refreshes this tab's history.
    const onUpdate = (h: string[]) => {
      if (!cancelled) setShellHistory(h);
    };
    completionsListeners.add(onUpdate);
    return () => {
      cancelled = true;
      completionsListeners.delete(onUpdate);
    };
  }, []);

  useEffect(() => {
    if (!input.trim()) {
      setContextual([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const cwdRes = await fetch(`${API_BASE}/session/${tabId}/cwd`);
        const { cwd } = await cwdRes.json();
        const url = `${API_BASE}/complete?cwd=${encodeURIComponent(cwd ?? '')}&input=${encodeURIComponent(input)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!cancelled) {
          setContextual(Array.isArray(data.completions) ? data.completions : []);
          setDropdownIndex(0);
          setDropdownOpen(false);
        }
      } catch {
        if (!cancelled) setContextual([]);
      }
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input, tabId]);

  const showDropdown = dropdownOpen && contextual.length > 0 && input.trim().length > 0;

  const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  const runningBlock = lastBlock && lastBlock.exit === null && !rawMode ? lastBlock : null;

  // 250ms grace period before showing the running badge so fast commands
  // (even chatty ones like `ls`) never flash a spinner that immediately
  // disappears. Long-running commands cross the threshold and get visible
  // feedback as expected.
  const [showRunning, setShowRunning] = useState(false);
  useEffect(() => {
    if (!runningBlock) {
      setShowRunning(false);
      return;
    }
    const t = setTimeout(() => setShowRunning(true), 250);
    return () => clearTimeout(t);
  }, [runningBlock?.id]);

  const suggestion = useMemo(() => {
    if (!input) return '';
    // 1) Contextual top match (also shown in dropdown)
    if (contextual[dropdownIndex]) {
      const c = contextual[dropdownIndex].value;
      if (c.startsWith(input) && c !== input) return c;
    }
    for (const item of contextual) {
      if (item.value.startsWith(input) && item.value !== input) return item.value;
    }
    // 2) In-session history
    for (let i = history.length - 1; i >= 0; i--) {
      const cmd = history[i];
      if (cmd.startsWith(input) && cmd !== input) return cmd;
    }
    // 3) Server-side history + defaults
    for (const cmd of serverCompletions) {
      if (cmd.startsWith(input) && cmd !== input) return cmd;
    }
    return '';
  }, [input, history, serverCompletions, contextual, dropdownIndex]);

  function acceptSuggestion() {
    if (suggestion) setInput(suggestion);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      if (input.length > 0) {
        setInput('');
        setHistoryIndex(null);
      } else {
        send('\x03');
      }
      return;
    }
    if (e.ctrlKey && e.key === 'd') {
      e.preventDefault();
      send('\x04');
      return;
    }
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      setBlocks([]);
      return;
    }
    if (e.key === 'Escape' && showDropdown) {
      e.preventDefault();
      setDropdownOpen(false);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (showDropdown) {
        const dir = e.shiftKey ? -1 : 1;
        setDropdownIndex((i) => (i + dir + contextual.length) % contextual.length);
      } else if (contextual.length > 0) {
        setDropdownIndex(0);
        setDropdownOpen(true);
      } else {
        acceptSuggestion();
      }
      return;
    }
    if (e.key === 'ArrowRight') {
      const el = e.currentTarget;
      if (suggestion && el.selectionStart === input.length) {
        e.preventDefault();
        acceptSuggestion();
        return;
      }
    }
    if (e.key === 'ArrowUp') {
      if (showDropdown) {
        e.preventDefault();
        setDropdownIndex((i) => Math.max(0, i - 1));
        return;
      }
      // In a multiline draft ArrowUp moves the caret between lines; only
      // recall history when the caret already sits on the first line.
      const el = e.currentTarget;
      if (el.value.slice(0, el.selectionStart ?? 0).includes('\n')) return;
      e.preventDefault();
      // Combined history: persisted shell history (newest-first → reverse to
      // oldest-first) followed by in-session entries. Filter by the prefix the
      // user originally typed so ArrowUp walks matches, not all of history.
      const combined = [...shellHistory].reverse().concat(history);
      const prefix = historyIndex === null ? input : historyPrefix;
      const matches: number[] = [];
      for (let i = 0; i < combined.length; i++) {
        if (!prefix || combined[i].startsWith(prefix)) matches.push(i);
      }
      if (matches.length === 0) return;
      // Walking position within `matches`. Translate the previous absolute
      // index to the closest match position so the next step is one older.
      let pos: number;
      if (historyIndex === null) {
        setHistoryPrefix(prefix);
        pos = matches.length - 1;
      } else {
        const cur = matches.indexOf(historyIndex);
        pos = cur === -1 ? matches.length - 1 : Math.max(0, cur - 1);
      }
      const idx = matches[pos];
      setHistoryIndex(idx);
      setInput(combined[idx]);
      return;
    }
    if (e.key === 'ArrowDown') {
      if (showDropdown) {
        e.preventDefault();
        setDropdownIndex((i) => Math.min(contextual.length - 1, i + 1));
        return;
      }
      // Only step history forward when the caret is on the last line;
      // otherwise let ArrowDown move between lines of the draft.
      const el = e.currentTarget;
      if (el.value.slice(el.selectionStart ?? 0).includes('\n')) return;
      e.preventDefault();
      if (historyIndex === null) return;
      const combined = [...shellHistory].reverse().concat(history);
      const prefix = historyPrefix;
      const matches: number[] = [];
      for (let i = 0; i < combined.length; i++) {
        if (!prefix || combined[i].startsWith(prefix)) matches.push(i);
      }
      const cur = matches.indexOf(historyIndex);
      if (cur === -1 || cur + 1 >= matches.length) {
        // Off the newest match — restore the originally-typed prefix.
        setHistoryIndex(null);
        setInput(prefix);
        return;
      }
      const idx = matches[cur + 1];
      setHistoryIndex(idx);
      setInput(combined[idx]);
      return;
    }
    if (e.key === 'Enter') {
      // When dropdown is open, Enter accepts the highlighted candidate into the
      // input instead of submitting the current input.
      if (showDropdown && contextual[dropdownIndex]) {
        e.preventDefault();
        setInput(contextual[dropdownIndex].value);
        setDropdownOpen(false);
        return;
      }
      // Shift+Enter inserts a newline (multiline draft); plain Enter submits.
      if (e.shiftKey) return;
      e.preventDefault();
      setDropdownOpen(false);
      const text = input;
      send(text + '\n');
      if (text.trim()) {
        setHistory((h) => [...h.slice(-200), text]);
        appendShellHistory(text);
      }
      setHistoryIndex(null);
      setInput('');
    }
  }

  return (
    <Box
      display="flex"
      flexDirection="column"
      w="100%"
      h="100%"
      bg="#010409"
      overflow="hidden"
      position="relative"
      // Refocus xterm after any pointerdown inside the terminal area while in
      // raw mode. Otherwise tapping/clicking on chrome (PinBar, chip strip, a
      // pinned action button, the on-screen key bar) silently steals focus
      // from xterm's helper textarea — the overlay still renders, the cursor
      // still blinks, but keystrokes go nowhere. The focus useEffect only
      // fires on rawMode/active/isRunning changes, so quiet focus drift wasn't
      // covered. PointerDown unifies mouse + touch so it works on iOS / Android
      // too; rAF lets the gesture's own focus change settle first before we
      // override it.
      onPointerDown={() => {
        if (!rawMode) return;
        requestAnimationFrame(() => xtermRef.current?.focus());
      }}
    >
      {/* Terminal region — output, shell footer, and the raw-mode xterm
          overlay. Wrapped so the overlay's `inset: 0` stops above the pin
          strip below, keeping action chips clickable on Claude tabs. */}
      <Box flex="1" minH="0" position="relative" display="flex" flexDirection="column">
      {/* xterm overlay — visible only in raw mode. Horizontal padding matches
          BlockCard's px="6" (24px) so ssh / claude / gum prompts line up with
          the surrounding block content. On the mobile layout we shrink it to
          8px: full-width TUIs (Claude Code's banner especially) need every
          column they can get, and 48px of chrome wraps the logo on a phone.
          Vertical buffer stays small — just enough to keep the cursor +
          bottom-line glyphs off the chrome. */}
      <Box
        position="absolute"
        inset="0"
        bg="#010409"
        zIndex={rawMode ? 5 : -1}
        visibility={rawMode ? 'visible' : 'hidden'}
        px={isMobile ? '8px' : '24px'}
        py="4px"
      >
        <Box
          ref={xtermHostRef}
          w="100%"
          h="100%"
          // iOS only summons the soft keyboard from a real user gesture, not a
          // programmatic .focus(). Routing the tap through onClick → term.focus()
          // makes that gesture explicit: any tap on the overlay re-summons the
          // keyboard if it had collapsed (e.g. after switching tabs). We also
          // re-pin to the bottom so a click recovers the prompt cursor when
          // xterm's viewport is stuck above the last row.
          onClick={() => {
            xtermRef.current?.focus();
            if (rawModeRef.current) xtermRef.current?.scrollToBottom();
          }}
        />
      </Box>

      {/* Initial-load overlay — shown from mount until subscribe replay
          finishes (replay-end) or the 1.5s safety timer fires. Covers blocks,
          xterm, and pending-block loader (zIndex 6) so the user never sees
          an empty xterm or stale blocks flash while history streams in. */}
      {loading && (
        <Box
          position="absolute"
          inset="0"
          bg="#010409"
          zIndex={6}
          display="flex"
          alignItems="center"
          justifyContent="center"
          pointerEvents="none"
        >
          <SquareLoader size={8} />
        </Box>
      )}

      <Box position="relative" flex="1" minH="0" display="flex">
        <Box
          ref={scrollRef}
          onScroll={onScroll}
          flex="1"
          overflowY="auto"
          // Never scroll the block list sideways — blocks that need it (diff,
          // interactive snapshots) carry their own inner horizontal scroll.
          overflowX="hidden"
          fontFamily="var(--grove-mono)"
          fontSize="var(--grove-mono-size)"
          color="#c9d1d9"
          display="flex"
          flexDirection="column"
        >
          <Box flex="1" />
          {blocks.map((b, i) => {
            // Always mount the last few blocks (the ones the user is
            // most likely looking at right after a command finishes) so
            // their first paint isn't gated on an IntersectionObserver
            // tick. Older blocks lazy-mount when they scroll near the
            // viewport.
            const forceMount = i >= blocks.length - 5;
            return (
              <LazyMount key={b.id} forceMount={forceMount}>
                <BlockCard
                  block={b}
                  ctxNode={ctx?.node ?? null}
                  cmdHeld={cmdHeld}
                  onDelete={() => setBlocks((bs) => bs.filter((x) => x.id !== b.id))}
                  onRerun={() => {
                    if (b.cmd) send(b.cmd + '\r');
                  }}
                />
              </LazyMount>
            );
          })}
        </Box>
        {!pinned && blocks.length > 0 && (
          <Box
            as="button"
            onClick={scrollToBottom}
            position="absolute"
            bottom="12px"
            right="16px"
            w="32px"
            h="32px"
            borderRadius="full"
            bg="#161b22"
            border="1px solid #30363d"
            color="#c9d1d9"
            cursor="pointer"
            display="flex"
            alignItems="center"
            justifyContent="center"
            boxShadow="0 4px 12px rgba(0,0,0,0.4)"
            transition="background 120ms ease, transform 120ms ease"
            _hover={{ bg: '#21262d', transform: 'translateY(-1px)' }}
            title="Scroll to bottom"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6l4 4 4-4" />
            </svg>
          </Box>
        )}
      </Box>

      <Box
        position="relative"
        onMouseDown={(e) => {
          // Focus the input when the user clicks anywhere in the footer (chip
          // strip, padding, prompt row), unless they clicked an interactive
          // element. Hoisted up from the input row so a click on a chip or the
          // chip strip's empty space also focuses the input.
          const target = e.target as HTMLElement;
          if (
            target.closest('button, a, input, textarea, select, [role="button"], [data-clickable]')
          )
            return;
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {showDropdown && (
          <Box
            position="absolute"
            bottom="100%"
            left="0"
            right="0"
            zIndex={20}
            pointerEvents="auto"
          >
            <CompletionDropdown
              items={contextual}
              selectedIndex={dropdownIndex}
              onPick={(i) => {
                setInput(contextual[i].value);
                setDropdownOpen(false);
                inputRef.current?.focus();
              }}
              onHover={setDropdownIndex}
            />
          </Box>
        )}

        {forkLockHint && (
          <Box
            mx="6"
            mb="1"
            px="2.5"
            py="1.5"
            bg="#3d2a1a"
            border="1px solid #7d4a1a"
            borderRadius="4px"
            color="#f0d9a8"
            fontSize="11px"
            fontFamily="var(--grove-mono)"
            display="flex"
            alignItems="center"
            gap="2"
          >
            <Box flex="1">
              <Text as="span" color="#f8c468" fontWeight="600">
                {forkLockHint.branch}
              </Text>
              {
                ' is checked out in another workspace. Switch that workspace to a different branch first.'
              }
            </Box>
            <button
              onClick={() => setForkLockHint(null)}
              title="Dismiss"
              style={{
                background: 'transparent',
                border: 'none',
                color: '#f0d9a8',
                cursor: 'pointer',
                padding: '2px 4px',
                borderRadius: 3,
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </Box>
        )}

        {/* Floating composer card — context chips + prompt row share one
            rounded, bordered surface, styled after the Claude.ai composer. */}
        <Box
          mx="6"
          mt="3"
          mb="2"
          border="1px solid #30363d"
          borderRadius="14px"
          bg="#0d1117"
          overflow="hidden"
        >
        <ChipStrip ctx={ctx} tabId={tabId} />

        <Box
          bg="transparent"
          px="4"
          pt="1"
          pb="3"
          display="flex"
          alignItems="flex-start"
          gap="2"
          position="relative"
        >
          {runningBlock && showRunning && (
            <RunningBadge cmd={runningBlock.cmd} onStop={() => send('\x03')} />
          )}
          <Box flex="1" position="relative" minH="22px">
            {suggestion && !runningBlock && !input.includes('\n') && (
              <Box
                position="absolute"
                inset="0"
                pointerEvents="none"
                fontFamily="var(--grove-mono)"
                fontSize="var(--grove-mono-size)"
                lineHeight="22px"
                color="#484f58"
                style={{
                  whiteSpace: 'pre',
                  letterSpacing: 0,
                  wordSpacing: 0,
                  fontFeatureSettings: '"liga" 0, "calt" 0',
                  fontVariantLigatures: 'none',
                  textRendering: 'geometricPrecision',
                  boxSizing: 'border-box',
                  padding: 0,
                  margin: 0,
                }}
              >
                <span style={{ color: 'transparent' }}>{input}</span>
                <span>{suggestion.slice(input.length)}</span>
                {suggestion.slice(input.length).length > 0 && (
                  <Box
                    as="span"
                    ml="3"
                    display="inline-flex"
                    alignItems="center"
                    gap="1"
                    px="1.5"
                    h="16px"
                    border="1px solid #30363d"
                    borderTopColor="#3d444d"
                    borderBottomColor="#22272e"
                    borderRadius="4px"
                    bg="#161b22"
                    color="#7d8590"
                    verticalAlign="middle"
                    fontSize="12px"
                    fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
                    fontWeight="600"
                    letterSpacing="0.06em"
                    textTransform="uppercase"
                    style={{ boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.35)' }}
                  >
                    <span>tab</span>
                  </Box>
                )}
              </Box>
            )}
            <textarea
              ref={inputRef}
              value={input}
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                setHistoryIndex(null);
              }}
              onKeyDown={(e) => {
                // While a non-raw block is running the textarea doubles as a
                // line-buffered stdin: scp/ssh/sudo password prompts, `read -p`,
                // npm yes/no prompts — none of these trip raw-mode detection,
                // so without this they're unreachable. Enter sends the typed
                // line + \n to the PTY; Ctrl+C / Ctrl+D still signal. Skip the
                // composer-only logic (history walk, dropdown, autocomplete)
                // since the user isn't typing the next command yet.
                if (runningBlock) {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(input + '\n');
                    setInput('');
                    return;
                  }
                  if (e.ctrlKey && (e.key === 'c' || e.key === 'd')) {
                    e.preventDefault();
                    send(e.key === 'c' ? '\x03' : '\x04');
                    if (e.key === 'c') setInput('');
                    return;
                  }
                  return;
                }
                onKeyDown(e);
                requestAnimationFrame(updateCaret);
              }}
              onKeyUp={updateCaret}
              onClick={updateCaret}
              onSelect={updateCaret}
              onScroll={updateCaret}
              onFocus={() => {
                setCaretVisible(true);
                updateCaret();
              }}
              onBlur={() => setCaretVisible(false)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={{
                width: '100%',
                minHeight: '22px',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                padding: 0,
                margin: 0,
                textIndent: 0,
                boxSizing: 'border-box',
                display: 'block',
                verticalAlign: 'top',
                appearance: 'none',
                WebkitAppearance: 'none',
                resize: 'none',
                letterSpacing: 0,
                wordSpacing: 0,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
                fontFamily: 'var(--grove-mono)',
                fontSize: 'var(--grove-mono-size)',
                lineHeight: '22px',
                color: '#c9d1d9',
                caretColor: 'transparent',
                position: 'relative',
                zIndex: 1,
                fontFeatureSettings: '"liga" 0, "calt" 0',
                fontVariantLigatures: 'none',
                textRendering: 'geometricPrecision',
              }}
            />
            {/* Hidden mirror of the textarea — replays text + soft-wrapping so
                updateCaret() can measure the caret's pixel row/column. */}
            <div
              ref={mirrorRef}
              aria-hidden
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                visibility: 'hidden',
                pointerEvents: 'none',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
                letterSpacing: 0,
                wordSpacing: 0,
                padding: 0,
                margin: 0,
                boxSizing: 'border-box',
                fontFamily: 'var(--grove-mono)',
                fontSize: 'var(--grove-mono-size)',
                lineHeight: '22px',
                fontFeatureSettings: '"liga" 0, "calt" 0',
                fontVariantLigatures: 'none',
                textRendering: 'geometricPrecision',
              }}
            />
            {caretVisible && !runningBlock && (
              <Box
                className="grove-caret"
                position="absolute"
                left={`${caretLeft}px`}
                top={`${caretTop + 4.5}px`}
                w="2px"
                h="13px"
                bg="#83C2D7"
                pointerEvents="none"
                zIndex={2}
              />
            )}
          </Box>
        </Box>
        </Box>
      </Box>
      </Box>
      <PinBar tabId={tabId} active={active} />
      {/* Phone-only on-screen key bar — soft keyboards lack arrow/Esc/Tab
          keys, so without this a raw-mode TUI can't be navigated on mobile.
          Writes straight to the PTY socket, the same channel xterm.onData
          uses, so it works whether or not xterm currently holds focus. */}
      {isMobile && rawMode && (
        <MobileKeyBar
          agent={tabKind === 'claude' ? 'claude' : undefined}
          onKey={(seq) => {
            const ws = wsRef.current;
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'input', data: seq }));
            }
          }}
        />
      )}
    </Box>
  );
}

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

function formatDuration(ms: number | null, running: boolean): string {
  if (ms === null) return running ? 'running…' : '';
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function DiffLabel({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) {
    return (
      <Text as="span" fontSize="12px" color="#7d8590" fontFamily="var(--grove-mono)">
        0
      </Text>
    );
  }
  return (
    <Text as="span" fontSize="12px" fontFamily="var(--grove-mono)" lineHeight="1">
      {added > 0 && (
        <Text as="span" color="#7ee787">
          +{added}
        </Text>
      )}
      {added > 0 && removed > 0 && (
        <Text as="span" color="#7d8590">
          {' '}
        </Text>
      )}
      {removed > 0 && (
        <Text as="span" color="#ff7b72">
          -{removed}
        </Text>
      )}
    </Text>
  );
}

function BlockCard({
  block,
  ctxNode,
  cmdHeld,
  onDelete,
  onRerun,
}: {
  block: Block;
  ctxNode: string | null;
  cmdHeld: boolean;
  onDelete: () => void;
  onRerun: () => void;
}) {
  const running = block.exit === null;
  const failed = block.exit !== null && block.exit !== 0;
  const durStr = formatDuration(block.durationMs, running);
  return (
    <Box
      px="6"
      py="2"
      borderTop="1px solid #21262d"
      borderLeft={failed ? '2px solid #f85149' : '2px solid transparent'}
      bg="transparent"
      transition="background 0.12s"
      _hover={{ bg: '#0d1117', '& .block-actions': { opacity: 1 } }}
      role="group"
    >
      <HStack
        gap="3"
        fontSize="12px"
        fontFamily="var(--grove-mono)"
        align="center"
        lineHeight="1.4"
        // Wrap the metadata to a second line on narrow viewports rather than
        // overflowing the block width.
        flexWrap="wrap"
      >
        {block.cwd && <Text color="#79c0ff">{shortPath(block.cwd)}</Text>}
        {ctxNode && <Text color="#7ee787">{ctxNode}</Text>}
        {block.exit !== null && block.exit !== 0 && <Text color="#f85149">✗ {block.exit}</Text>}
        {durStr && <Text color="#7d8590">({durStr})</Text>}
        {block.interactive && (
          <Text
            px="1.5"
            py="0.5"
            ml="1"
            fontSize="9px"
            lineHeight="1"
            color="#83C2D7"
            border="1px solid #30363d"
            borderRadius="3px"
            bg="#161b22"
            textTransform="uppercase"
            letterSpacing="0.06em"
            fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
            fontWeight="600"
          >
            interactive
          </Text>
        )}
        <Box flex="1" display={{ base: 'none', md: 'block' }} />
        <Box
          className="block-actions"
          display={{ base: 'none', md: 'block' }}
          opacity="0"
          transition="opacity 0.12s"
          color="#7d8590"
        >
          <BlockMenu
            onRerun={block.cmd ? onRerun : undefined}
            onCopyCmd={() => navigator.clipboard.writeText(block.cmd || '').catch(() => {})}
            onCopyOutput={() => navigator.clipboard.writeText(block.output || '').catch(() => {})}
            onPin={
              block.cmd
                ? () =>
                    useStore.getState().setPendingPinDraft({
                      label: block.cmd!.slice(0, 20),
                      type: 'shell',
                      command: block.cmd!,
                      scope: 'global',
                    })
                : undefined
            }
            onDelete={onDelete}
          />
        </Box>
      </HStack>
      {block.cmd && (
        <Text
          mt="1"
          mb={block.output ? '1' : '0'}
          color="#f0f6fc"
          fontWeight="700"
          fontFamily="var(--grove-mono)"
          fontSize="var(--grove-mono-size)"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {block.cmd}
        </Text>
      )}
      {block.output && (
        <Box
          className={cmdHeld ? 'grove-output grove-cmd-held' : 'grove-output'}
          color="#c9d1d9"
          fontFamily="var(--grove-mono)"
          fontSize="var(--grove-mono-size)"
          lineHeight="1"
          overflowX={block.interactive ? 'auto' : undefined}
          style={{
            // Interactive snapshots are alt-screen frames padded to terminal
            // width — wrapping them shatters box-drawing layout. Scroll instead.
            whiteSpace: block.interactive ? 'pre' : 'pre-wrap',
            wordBreak: block.interactive ? 'normal' : 'break-word',
            letterSpacing: 0,
            fontKerning: 'none',
            fontFeatureSettings: '"liga" 0, "calt" 0, "kern" 0',
            fontVariantLigatures: 'none',
            cursor: cmdHeld ? 'pointer' : 'text',
          }}
        >
          <TerminalOutput text={block.output} cwd={block.cwd} />
        </Box>
      )}
    </Box>
  );
}

function BlockMenu({
  onRerun,
  onCopyCmd,
  onCopyOutput,
  onPin,
  onDelete,
}: {
  onRerun?: () => void;
  onCopyCmd: () => void;
  onCopyOutput: () => void;
  onPin?: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);
  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const MENU_H = 170; // ~5 items * ~32px + padding/border; close enough for flip
      const right = window.innerWidth - rect.right;
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < MENU_H + 8 && rect.top > MENU_H + 8) {
        setPos({ bottom: window.innerHeight - rect.top + 4, right });
      } else {
        setPos({ top: rect.bottom + 4, right });
      }
    }
    setOpen((v) => !v);
  };
  const item = (label: string, onClick: () => void, danger = false) => (
    <Box
      as="button"
      onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
      onClick={() => {
        // Close the portal synchronously so it's committed to the DOM before
        // the action (which may unmount this component) runs. Without flushSync
        // the close gets batched with downstream state changes and the portal
        // can be left visually stuck.
        flushSync(() => setOpen(false));
        onClick();
      }}
      display="block"
      w="100%"
      textAlign="left"
      px="3"
      py="1.5"
      fontSize="12px"
      color={danger ? '#ff7b72' : '#c9d1d9'}
      bg="transparent"
      border="none"
      cursor="pointer"
      _hover={{ bg: danger ? '#3a1a1a' : '#21262d' }}
    >
      {label}
    </Box>
  );
  return (
    <>
      <button
        ref={btnRef}
        title="More"
        onClick={openMenu}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'inherit',
          padding: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 3,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="3.5" cy="8" r="1.2" />
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="12.5" cy="8" r="1.2" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <Box
            ref={menuRef}
            position="fixed"
            top={pos.top !== undefined ? `${pos.top}px` : undefined}
            bottom={pos.bottom !== undefined ? `${pos.bottom}px` : undefined}
            right={`${pos.right}px`}
            minW="160px"
            bg="#161b22"
            border="1px solid #30363d"
            borderRadius="6px"
            py="1"
            zIndex={1000}
            boxShadow="0 8px 24px rgba(0,0,0,0.4)"
          >
            {onRerun && item('Rerun command', onRerun)}
            {item('Copy command', onCopyCmd)}
            {item('Copy output', onCopyOutput)}
            {onPin && item('Pin this command', onPin)}
            <Box my="1" h="1px" bg="#30363d" />
            {item('Delete', onDelete, true)}
          </Box>,
          document.body,
        )}
    </>
  );
}

function BlockActionIcon({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: 'inherit',
        padding: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 3,
      }}
    >
      {children}
    </button>
  );
}

function RunningBadge({ cmd, onStop }: { cmd: string; onStop: () => void }) {
  const truncated = cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd;
  return (
    <Box
      display="inline-flex"
      alignItems="center"
      gap="2"
      h="22px"
      lineHeight="22px"
      fontFamily="var(--grove-mono)"
      fontSize="var(--grove-mono-size)"
      color="#484f58"
      flexShrink="0"
      minW="0"
    >
      <SquareLoader ariaLabel="running" />
      <Box as="span" truncate maxW="360px">
        {truncated}
      </Box>
      <Box
        as="button"
        onClick={onStop}
        display="inline-flex"
        alignItems="center"
        px="1.5"
        h="16px"
        border="none"
        bg="transparent"
        color="#7d8590"
        fontSize="12px"
        fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
        fontWeight="600"
        letterSpacing="0.06em"
        textTransform="uppercase"
        cursor="pointer"
        title="Send SIGINT to the running process"
        _hover={{ color: '#f85149' }}
      >
        ^C stop
      </Box>
    </Box>
  );
}

function ChipStrip({ ctx, tabId }: { ctx: ReturnType<typeof useTabContext>; tabId: string }) {
  // Split into two primitive-returning selectors so each only re-renders when
  // its own slice actually changes — a combined object selector would churn on
  // every store tick.
  const groupCwd = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    return tab ? s.groups.find((g) => g.id === tab.groupId)?.cwd : undefined;
  });
  const isFork = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    return tab ? !!s.groups.find((g) => g.id === tab.groupId)?.forkedFromId : false;
  });
  // Only trust ctx.shortCwd once the backend confirms the pty session has
  // initialized (cwdReady). Otherwise the HTTP /context fetch on first mount
  // — which fires before the WS-spawned session exists — returns shortCwd "~"
  // (os.homedir() fallback) and the chip flickers cwd → ~ → cwd as the WS
  // catches up. groupCwd is the workspace folder, the right pre-ready value.
  const cwd = (ctx?.cwdReady && ctx.shortCwd) || (groupCwd ? shortPath(groupCwd) : '');
  const cwdLoading = !cwd;
  // Collapse chips to icon-only when the strip's own width is too narrow to
  // show labels — driven by the strip's measured rect, not the window
  // viewport, so a narrow pane in a split (or a workspace with a wide
  // sidebar) collapses correctly even on a wide display.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 520,
  );
  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const COMPACT_THRESHOLD = 420;
    const update = (w: number) => setCompact(w < COMPACT_THRESHOLD);
    update(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const branch = ctx?.branch
    ? isFork && ctx.branch.startsWith('grove/')
      ? ctx.branch.slice('grove/'.length)
      : ctx.branch
    : '';
  return (
    <HStack
      ref={stripRef}
      px="4"
      pt="3"
      pb="0"
      gap="2"
      bg="transparent"
      flexWrap="wrap"
    >
      <Chip
        icon={<FolderIcon size={12} />}
        compact={compact}
        tooltip={cwdLoading ? undefined : cwd}
        label={
          cwdLoading ? (
            <Text
              as="span"
              color="#484f58"
              style={{ filter: 'blur(5px)', opacity: 0.5, userSelect: 'none' }}
            >
              loading…
            </Text>
          ) : (
            cwd
          )
        }
      />
      {ctx?.node && (
        <Chip
          icon={<NodeIcon />}
          label={ctx.node}
          labelColor="#7ee787"
          compact={compact}
          tooltip={`node ${ctx.node}`}
        />
      )}
      {branch && (
        <BranchPopoverTrigger cwd={groupCwd ?? ''}>
          <Chip
            icon={<BranchIcon size={12} />}
            label={branch}
            labelColor="#7ee787"
            compact={compact}
            // Tooltip would race the popover (both react to hover); the
            // popover itself surfaces enough context.
          />
        </BranchPopoverTrigger>
      )}
      {ctx?.diff && ctx.diff.files > 0 && (
        <Chip
          icon={<DiffIcon />}
          label={<DiffLabel added={ctx.diff.added} removed={ctx.diff.removed} />}
          compact={compact}
          tooltip={`${ctx.diff.files} file${ctx.diff.files === 1 ? '' : 's'} changed · +${ctx.diff.added} −${ctx.diff.removed}`}
        />
      )}
      {ctx?.pr && <PrChip pr={ctx.pr} compact={compact} />}
      {ctx?.env?.venv && (
        <Chip
          prefix="venv"
          label={ctx.env.venv}
          labelColor="#79c0ff"
          compact={compact}
          tooltip={`venv ${ctx.env.venv}`}
        />
      )}
      {ctx?.env?.conda && (
        <Chip
          prefix="conda"
          label={ctx.env.conda}
          labelColor="#d2a8ff"
          compact={compact}
          tooltip={`conda ${ctx.env.conda}`}
        />
      )}
      {ctx?.env?.aws && (
        <Chip
          prefix="aws"
          label={ctx.env.aws}
          labelColor="#f59e0b"
          compact={compact}
          tooltip={`aws ${ctx.env.aws}`}
        />
      )}
      {ctx?.env?.k8s && (
        <Chip
          prefix="k8s"
          label={ctx.env.k8s}
          labelColor="#56d4dd"
          compact={compact}
          tooltip={`k8s ${ctx.env.k8s}`}
        />
      )}
    </HStack>
  );
}

function Chip({
  icon,
  prefix,
  label,
  labelColor,
  tooltip,
  compact,
}: {
  icon?: React.ReactNode;
  prefix?: string;
  label: React.ReactNode;
  labelColor?: string;
  tooltip?: React.ReactNode;
  compact?: boolean;
}) {
  // In compact mode the chip shrinks to just its icon (or its prefix, for the
  // icon-less env chips) and the value lives in the tooltip. Otherwise the
  // label stays on one line and ellipsis-truncates rather than wrapping out of
  // the fixed-height box. tabIndex makes the collapsed chip focusable so a tap
  // can surface the tooltip on touch devices.
  const showLabel = !compact;
  const showPrefix = prefix && (showLabel || !icon);
  const body = (
    <HStack
      gap="1.5"
      px="2"
      h="22px"
      maxW="100%"
      flexShrink={0}
      bg="#0d1117"
      border="1px solid #21262d"
      borderRadius="5px"
      align="center"
      lineHeight="1"
      tabIndex={compact ? 0 : undefined}
      cursor={compact ? 'default' : undefined}
    >
      {icon && (
        <Box
          color={labelColor ?? '#7d8590'}
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="12px"
          h="12px"
          flexShrink={0}
        >
          {icon}
        </Box>
      )}
      {showPrefix && (
        <Text
          fontSize="12px"
          color="#7d8590"
          fontFamily="var(--grove-mono)"
          fontWeight="600"
          lineHeight="1"
          textTransform="lowercase"
          flexShrink={0}
        >
          {prefix}
        </Text>
      )}
      {showLabel && (
        <Text
          fontSize="12px"
          color={labelColor ?? '#c9d1d9'}
          fontFamily="var(--grove-mono)"
          fontWeight="500"
          lineHeight="1"
          minW="0"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
        >
          {label}
        </Text>
      )}
    </HStack>
  );
  return tooltip == null ? body : <Tooltip label={tooltip}>{body}</Tooltip>;
}

function CompletionDropdown({
  items,
  selectedIndex,
  onPick,
  onHover,
}: {
  items: CompletionItem[];
  selectedIndex: number;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
}) {
  const kindLabel: Record<CompletionItem['kind'], string> = {
    dir: 'Directory',
    file: 'File',
    branch: 'Branch',
    script: 'Script',
  };
  return (
    <Box
      mx="3"
      mb="1"
      maxH="260px"
      overflowY="auto"
      bg="#0d1117"
      border="1px solid #21262d"
      borderRadius="8px"
      boxShadow="0 10px 30px rgba(0,0,0,0.5)"
      py="1"
      style={{ alignSelf: 'flex-start', maxWidth: '480px' }}
    >
      {items.slice(0, 12).map((item, i) => {
        const isSel = i === selectedIndex;
        return (
          <Box
            key={item.value + i}
            px="3"
            py="1.5"
            bg={isSel ? '#1f6feb' : 'transparent'}
            color={isSel ? '#ffffff' : '#c9d1d9'}
            cursor="pointer"
            display="flex"
            alignItems="center"
            gap="2"
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(i);
            }}
          >
            <Box color={isSel ? '#ffffff' : '#7d8590'} display="flex" alignItems="center">
              {item.kind === 'dir' && <FolderIcon size={12} />}
              {item.kind === 'file' && <FileIcon />}
              {item.kind === 'branch' && <BranchIcon size={12} />}
              {item.kind === 'script' && <ScriptIcon />}
            </Box>
            <Text
              fontFamily="var(--grove-mono)"
              fontSize="var(--grove-mono-size)"
              fontWeight={isSel ? '600' : '500'}
              flex="1"
              truncate
            >
              {item.label}
            </Text>
            <Text
              fontFamily="var(--grove-mono)"
              fontSize="12px"
              color={isSel ? '#cce0ff' : '#7d8590'}
            >
              {kindLabel[item.kind]}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function PrChip({ pr, compact }: { pr: NonNullable<TabContext['pr']>; compact?: boolean }) {
  const color = pr.draft
    ? '#8b949e'
    : pr.state === 'MERGED'
      ? '#d2a8ff'
      : pr.state === 'CLOSED'
        ? '#f85149'
        : '#79c0ff';
  return (
    <Box
      as="button"
      onClick={() => {
        // GitHub refuses to be iframed (frame-ancestors 'none'), so open the
        // PR in the system browser where extensions / sessions actually work.
        if (pr.url) window.grove?.openExternal?.(pr.url);
      }}
      cursor="pointer"
      bg="transparent"
      border="none"
      p="0"
    >
      <Chip
        icon={<PrIcon />}
        label={`#${pr.number}${pr.draft ? ' draft' : ''}`}
        labelColor={color}
        compact={compact}
        tooltip={`${pr.draft ? 'Draft ' : ''}${pr.state}: ${pr.title || `#${pr.number}`}`}
      />
    </Box>
  );
}
