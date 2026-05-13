import { useEffect, useLayoutEffect, useMemo, useRef, useState, KeyboardEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Box, HStack, Text } from '@chakra-ui/react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTabContext, setTabContext, type TabContext } from './useTabContext';
import { useStore } from './store';
import { API_BASE, WS_BASE } from './api';
import { TerminalOutput } from './TerminalOutput';

const ALT_ON   = /\x1b\[\?(?:1049|47|1047)h/g;
const ALT_OFF  = /\x1b\[\?(?:1049|47|1047)l/g;
const CURS_OFF = /\x1b\[\?25l/g;
const CURS_ON  = /\x1b\[\?25h/g;

type RawKind = 'alt' | 'cursor';
interface RawTransition { on: boolean; kind: RawKind }

// Scan for the LAST h/l toggle of a given pair. Returns null if neither appears.
function lastToggle(text: string, onRe: RegExp, offRe: RegExp): boolean | null {
  let lastIdx = -1;
  let val: boolean | null = null;
  let m: RegExpExecArray | null;
  onRe.lastIndex = 0;
  while ((m = onRe.exec(text))) {
    if (m.index > lastIdx) { lastIdx = m.index; val = true; }
  }
  offRe.lastIndex = 0;
  while ((m = offRe.exec(text))) {
    if (m.index > lastIdx) { lastIdx = m.index; val = false; }
  }
  return val;
}

interface RawScan { alt: boolean | null; cursor: boolean | null }

function detectRawScan(text: string): RawScan {
  return {
    alt: lastToggle(text, ALT_ON, ALT_OFF),
    cursor: lastToggle(text, CURS_OFF, CURS_ON),
  };
}

interface Props { tabId: string; active: boolean }

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
// Edge case: this is a heuristic, not real termios watching. We miss TUIs
// invoked via aliases/wrapper scripts whose names aren't in this list AND
// that don't emit alt-screen (?1049h) or cursor-hide (?25l). Warp solves
// this by watching PTY termios for ICANON/ECHO flips — node-pty doesn't
// expose termios, so the proper fix would be either an `ffi-napi` binding
// (`tcgetattr` via libc) or backend polling of the shell's foreground
// child process (pgrep + ps). Both are deferred; revisit if a real TUI
// trips through unnoticed.
const INTERACTIVE_CMD_RE =
  /(?:^|[|;&]\s*)(?:sudo\s+|env\s+\w+=\S+\s+)*(ssh|mosh|telnet|tmux|screen|nano|vim?|nvim|emacs|less|more|man|top|htop|btop|nload|iftop|python\d*|ipython|node|deno|bun|psql|mysql|mongosh?|redis-cli|sqlite3|gh|gum|claude|fzf|lazygit|tig|k9s)\b/;
function isInteractiveCmd(cmd: string): boolean {
  return INTERACTIVE_CMD_RE.test(cmd.trim());
}

interface CompletionItem { value: string; label: string; kind: 'dir' | 'file' | 'branch' | 'script' }

let serverCompletionsCache: string[] = [];
let serverCompletionsFetchedAt = 0;
async function fetchServerCompletions(): Promise<string[]> {
  if (Date.now() - serverCompletionsFetchedAt < 30_000 && serverCompletionsCache.length) {
    return serverCompletionsCache;
  }
  try {
    const res = await fetch(API_BASE + '/completions');
    const data = await res.json();
    serverCompletionsCache = Array.isArray(data.completions) ? data.completions : [];
    serverCompletionsFetchedAt = Date.now();
  } catch {}
  return serverCompletionsCache;
}

const MAX_BLOCK_OUTPUT = 200_000;
const capOutput = (s: string): string => s.length > MAX_BLOCK_OUTPUT ? s.slice(-MAX_BLOCK_OUTPUT) : s;

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
  const flush = () => { if (pending) { result += pending; pending = ''; } };
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
      if (incoming[i + 1] === '\n') { flush(); result += '\n'; i += 2; }
      else { killCurrentLine(); i++; }
    } else if (ch === '\n') {
      flush(); result += '\n'; i++;
    } else if (ch === '\x1b' && incoming[i + 1] === '[') {
      let j = i + 2;
      while (j < incoming.length && /[0-9;?]/.test(incoming[j])) j++;
      if (j >= incoming.length) { pending += ch; i++; continue; }
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

export function TerminalView({ tabId, active }: Props) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const isRunning = useStore((s) => !!s.runningCmds[tabId]);
  const cmdHeld = useCmdHeld();
  const ctx = useTabContext(tabId, 0, 0, active || isRunning);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentBlockRef = useRef<number | null>(null);
  const [caretLeft, setCaretLeft] = useState(0);
  const [caretVisible, setCaretVisible] = useState(true);
  const charWidthRef = useRef<number>(7.8);
  const [altScreen, setAltScreen] = useState(false);
  const [cursorHide, setCursorHide] = useState(false);
  const [forcedRaw, setForcedRaw] = useState(false);
  const rawMode = altScreen || cursorHide || forcedRaw;
  const rawKind: RawKind = altScreen || forcedRaw ? 'alt' : 'cursor';
  const rawModeRef = useRef(false);
  const inPromptRef = useRef(true);
  const xtermHostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const altCarryRef = useRef<string>('');
  const pendingOutputRef = useRef<Map<number, string>>(new Map());
  const pendingBlockRef = useRef<Block | null>(null);
  const flushRafRef = useRef<number | null>(null);

  function flushPendingOutput() {
    flushRafRef.current = null;
    const snapshot = pendingOutputRef.current;
    if (snapshot.size === 0 && !pendingBlockRef.current) return;
    pendingOutputRef.current = new Map();
    const pending = pendingBlockRef.current;
    pendingBlockRef.current = null;
    // The updater must be pure — React 18 StrictMode double-invokes it in
    // dev, so we can't mutate `snapshot` (e.g. .delete) here. Instead we
    // skip the just-committed pending block while mapping so its initial
    // output isn't re-applied via applyCarriageReturns.
    setBlocks((bs) => {
      let next = bs;
      if (pending) {
        const firstChunk = snapshot.get(pending.id) ?? '';
        next = [...bs.slice(-200), { ...pending, output: capOutput(firstChunk) }];
      }
      if (snapshot.size === 0) return next;
      return next.map((b) => {
        const chunk = snapshot.get(b.id);
        if (!chunk) return b;
        if (pending && b.id === pending.id) return b;
        return { ...b, output: capOutput(applyCarriageReturns(b.output, chunk)) };
      });
    });
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
      ws.onopen = () => {
        attempt = 0;
        ws.send(JSON.stringify({ type: 'resize', cols: 200, rows: 50 }));
        // Clear any stale readline buffer pollution (Ctrl-U = kill-whole-line)
        ws.send(JSON.stringify({ type: 'input', data: '\x15' }));
      };
      ws.onclose = () => {
        if (closed) return;
        attempt += 1;
        const delay = Math.min(2000, 200 * 2 ** Math.min(attempt - 1, 4));
        if (attempt > 8) {
          console.error('[grove] failed to connect to backend at 127.0.0.1:4317 after multiple attempts');
          return;
        }
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => { /* handled in onclose */ };
      ws.onmessage = (ev) => {
        // Drop events from a stale socket. React 18 StrictMode runs the effect
        // twice in dev: the first WS subscribes and the backend immediately
        // sends a block replay, which would land in shared component state
        // (refs/setBlocks) and double everything. Cleanup flips `closed=true`
        // so the doomed socket's events get discarded.
        if (closed || ws !== wsRef.current) return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'raw') {
            const scan = altCarryRef.current + msg.data;
            const result = detectRawScan(scan);
            const willEnterRaw =
              ((result.alt === true) || (result.cursor === true)) && !rawModeRef.current;

            if (willEnterRaw) xtermRef.current?.reset();
            xtermRef.current?.write(msg.data);

            if (result.alt !== null) setAltScreen(result.alt);
            if (result.cursor !== null) setCursorHide(result.cursor);

            if (willEnterRaw) {
              const cur = currentBlockRef.current;
              if (cur !== null) {
                setBlocks((bs) => bs.map((b) =>
                  b.id === cur ? { ...b, interactive: true, output: '' } : b,
                ));
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
            pendingBlockRef.current = null;
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
            inPromptRef.current = false;
            const id = ++blockCounter;
            currentBlockRef.current = id;
            const interactive = isInteractiveCmd(msg.cmd ?? '');
            // Don't render an empty block for one frame before output arrives —
            // park it in a ref and commit only on first output or block-end.
            // Interactive commands (vim, top) commit immediately because their
            // output goes to xterm, not the block list.
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
            if (interactive) {
              setBlocks((bs) => [...bs.slice(-200), pending]);
              pendingBlockRef.current = null;
              xtermRef.current?.reset();
              setForcedRaw(true);
              rawModeRef.current = true;
            } else {
              pendingBlockRef.current = pending;
            }
            useStore.getState().setRunningCmd(tabId, msg.cmd || '');
          } else if (msg.type === 'ctx') {
            setTabContext(tabId, msg.ctx);
          } else if (msg.type === 'block-end') {
            const cur = currentBlockRef.current;
            const pending = pendingBlockRef.current;
            if (pending && pending.id === cur) {
              // Block had no output at all — commit a finalized empty one.
              setBlocks((bs) => [...bs.slice(-200), { ...pending, exit: msg.exit, durationMs: msg.durationMs }]);
              pendingBlockRef.current = null;
            } else if (cur !== null) {
              setBlocks((bs) => bs.map((b) =>
                b.id === cur ? { ...b, exit: msg.exit, durationMs: msg.durationMs } : b,
              ));
            }
            currentBlockRef.current = null;
            inPromptRef.current = true;
            setForcedRaw(false);
            useStore.getState().setRunningCmd(tabId, null);
          }
        } catch {}
      };
    }

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (flushRafRef.current !== null) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = null;
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
      fontSize: 13,
      theme: { background: '#010409', foreground: '#c9d1d9' },
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(xtermHostRef.current);
    xtermRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      // Only forward to PTY in raw mode. Otherwise xterm's auto-responses to
      // terminal queries (DA, cursor position, etc.) pollute the input stream.
      if (!rawModeRef.current) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    function doFitAndResize() {
      try { fit.fit(); } catch {}
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }
    const ro = new ResizeObserver(doFitAndResize);
    ro.observe(xtermHostRef.current);

    // Re-measure after fonts load (xterm caches cell width on open).
    const fontsReady = (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready;
    if (fontsReady) fontsReady.then(() => {
      // Touching fontFamily forces xterm to flush its cached metrics.
      const fam = term.options.fontFamily;
      term.options.fontFamily = 'monospace';
      term.options.fontFamily = fam;
      doFitAndResize();
    });
    const t1 = setTimeout(doFitAndResize, 100);
    const t2 = setTimeout(doFitAndResize, 500);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
      term.dispose();
      xtermRef.current = null;
    };
  }, [tabId]);

  useEffect(() => { rawModeRef.current = rawMode; }, [rawMode]);

  useEffect(() => {
    if (rawMode && active) {
      requestAnimationFrame(() => {
        const t = xtermRef.current;
        const f = fitRef.current;
        const ws = wsRef.current;
        if (!t || !f) return;
        try { f.fit(); } catch {}
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
        }
        t.focus();
      });
    } else if (active && !isRunning) {
      inputRef.current?.focus();
    }
  }, [rawMode, active, isRunning]);

  useEffect(() => {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (ctx) {
      const fam = getComputedStyle(document.documentElement).getPropertyValue('--grove-mono') || 'monospace';
      ctx.font = `13px ${fam}`;
      const w = ctx.measureText('M').width;
      if (w > 0) charWidthRef.current = w;
    }
  }, []);

  function updateCaret() {
    const el = inputRef.current;
    if (!el) return;
    const pos = el.selectionStart ?? input.length;
    setCaretLeft(pos * charWidthRef.current);
  }

  useEffect(() => { updateCaret(); }, [input]);

  function send(data: string) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
  }

  const [serverCompletions, setServerCompletions] = useState<string[]>(serverCompletionsCache);
  const [contextual, setContextual] = useState<CompletionItem[]>([]);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchServerCompletions().then((list) => { if (!cancelled) setServerCompletions(list); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!input.trim()) { setContextual([]); return; }
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
    return () => { cancelled = true; clearTimeout(timer); };
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
    if (!runningBlock) { setShowRunning(false); return; }
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

  function acceptSuggestion() { if (suggestion) setInput(suggestion); }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
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
    if (e.ctrlKey && e.key === 'd') { e.preventDefault(); send('\x04'); return; }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); setBlocks([]); return; }
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
        e.preventDefault(); acceptSuggestion(); return;
      }
    }
    if (e.key === 'ArrowUp') {
      if (showDropdown) {
        e.preventDefault();
        setDropdownIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (history.length === 0) return;
      e.preventDefault();
      const idx = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(idx); setInput(history[idx]); return;
    }
    if (e.key === 'ArrowDown') {
      if (showDropdown) {
        e.preventDefault();
        setDropdownIndex((i) => Math.min(contextual.length - 1, i + 1));
        return;
      }
      if (historyIndex === null) return;
      e.preventDefault();
      const idx = historyIndex + 1;
      if (idx >= history.length) { setHistoryIndex(null); setInput(''); }
      else { setHistoryIndex(idx); setInput(history[idx]); }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // When dropdown is open, Enter accepts the highlighted candidate into the
      // input instead of submitting the current input.
      if (showDropdown && contextual[dropdownIndex]) {
        setInput(contextual[dropdownIndex].value);
        setDropdownOpen(false);
        return;
      }
      setDropdownOpen(false);
      const text = input;
      send(text + '\n');
      if (text.trim()) setHistory((h) => [...h.slice(-200), text]);
      setHistoryIndex(null);
      setInput('');
    }
  }

  return (
    <Box display="flex" flexDirection="column" w="100%" h="100%" bg="#010409" overflow="hidden" position="relative">
      {/* xterm overlay — visible only in raw mode.
          Alt-screen apps (vim, htop, less) get edge-to-edge.
          Inline cursor-hide apps (claude, gum) keep block-style padding. */}
      <Box
        position="absolute"
        inset="0"
        bg="#010409"
        zIndex={rawMode ? 5 : -1}
        visibility={rawMode ? 'visible' : 'hidden'}
        px={rawKind === 'alt' ? '0' : '2'}
        py={rawKind === 'alt' ? '0' : '2'}
      >
        <Box ref={xtermHostRef} w="100%" h="100%" />
      </Box>

      <Box position="relative" flex="1" minH="0" display="flex">
        <Box
          ref={scrollRef}
          onScroll={onScroll}
          flex="1"
          overflowY="auto"
          fontFamily="var(--grove-mono)"
          fontSize="13px"
          color="#c9d1d9"
          display="flex"
          flexDirection="column"
          borderBottom="1px solid #21262d"
        >
          <Box flex="1" />
          {blocks.map((b) => (
            <BlockCard
              key={b.id}
              block={b}
              ctxNode={ctx?.node ?? null}
              cmdHeld={cmdHeld}
              onDelete={() => setBlocks((bs) => bs.filter((x) => x.id !== b.id))}
              onRerun={() => { if (b.cmd) send(b.cmd + '\r'); }}
            />
          ))}
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
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6l4 4 4-4" />
            </svg>
          </Box>
        )}
      </Box>

      <Box position="relative">
        {showDropdown && (
          <Box position="absolute" bottom="100%" left="0" right="0" zIndex={20} pointerEvents="auto">
            <CompletionDropdown
              items={contextual}
              selectedIndex={dropdownIndex}
              onPick={(i) => { setInput(contextual[i].value); setDropdownOpen(false); inputRef.current?.focus(); }}
              onHover={setDropdownIndex}
            />
          </Box>
        )}

      <ChipStrip ctx={ctx} tabId={tabId} />

      <Box bg="#010409" px="4" pt="1" pb="4" display="flex" alignItems="center" gap="2" position="relative">
        {runningBlock && showRunning && <RunningBadge cmd={runningBlock.cmd} onStop={() => send('\x03')} />}
        <Box flex="1" position="relative" h="22px">
          {suggestion && !runningBlock && (
            <Box position="absolute" inset="0" pointerEvents="none"
              fontFamily="var(--grove-mono)" fontSize="13px" lineHeight="22px" color="#484f58"
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
          <input
            ref={inputRef}
            value={input}
            readOnly={!!runningBlock}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (runningBlock) return; onKeyDown(e); requestAnimationFrame(updateCaret); }}
            onKeyUp={updateCaret}
            onClick={updateCaret}
            onSelect={updateCaret}
            onFocus={() => { setCaretVisible(true); updateCaret(); }}
            onBlur={() => setCaretVisible(false)}
            autoComplete="off" autoCorrect="off" spellCheck={false}
            style={{
              width: '100%', height: '22px', background: 'transparent',
              border: 'none', outline: 'none',
              padding: 0, margin: 0, textIndent: 0,
              boxSizing: 'border-box',
              display: 'block',
              verticalAlign: 'top',
              appearance: 'none',
              WebkitAppearance: 'none',
              letterSpacing: 0,
              wordSpacing: 0,
              fontFamily: 'var(--grove-mono)', fontSize: '13px', lineHeight: '22px',
              color: '#c9d1d9', caretColor: 'transparent',
              position: 'relative', zIndex: 1,
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
              top="4.5px"
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
    return <Text as="span" fontSize="12px" color="#7d8590" fontFamily="var(--grove-mono)">0</Text>;
  }
  return (
    <Text as="span" fontSize="12px" fontFamily="var(--grove-mono)" lineHeight="1">
      {added > 0 && <Text as="span" color="#7ee787">+{added}</Text>}
      {added > 0 && removed > 0 && <Text as="span" color="#7d8590">{' '}</Text>}
      {removed > 0 && <Text as="span" color="#ff7b72">-{removed}</Text>}
    </Text>
  );
}

function BlockCard({ block, ctxNode, cmdHeld, onDelete, onRerun }: { block: Block; ctxNode: string | null; cmdHeld: boolean; onDelete: () => void; onRerun: () => void }) {
  const running = block.exit === null;
  const failed = block.exit !== null && block.exit !== 0;
  const durStr = formatDuration(block.durationMs, running);
  return (
    <Box
      px="4"
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
      >
        {block.cwd && <Text color="#79c0ff">{shortPath(block.cwd)}</Text>}
        {ctxNode && <Text color="#7ee787">{ctxNode}</Text>}
        {block.exit !== null && block.exit !== 0 && (
          <Text color="#f85149">✗ {block.exit}</Text>
        )}
        {durStr && <Text color="#7d8590">({durStr})</Text>}
        {block.interactive && (
          <Text
            px="1.5"
            py="0.5"
            ml="1"
            fontSize="12px"
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
        <Box flex="1" />
        <Box
          className="block-actions"
          opacity="0"
          transition="opacity 0.12s"
          color="#7d8590"
        >
          <BlockMenu
            onRerun={block.cmd ? onRerun : undefined}
            onCopyCmd={() => navigator.clipboard.writeText(block.cmd || '').catch(() => {})}
            onCopyOutput={() => navigator.clipboard.writeText(block.output || '').catch(() => {})}
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
          fontSize="13px"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {block.cmd}
        </Text>
      )}
      {!block.interactive && block.output && (
        <Box
          className={cmdHeld ? 'grove-output grove-cmd-held' : 'grove-output'}
          color="#c9d1d9"
          fontFamily="var(--grove-mono)"
          fontSize="13px"
          lineHeight="1"
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
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

function BlockMenu({ onRerun, onCopyCmd, onCopyOutput, onDelete }: { onRerun?: () => void; onCopyCmd: () => void; onCopyOutput: () => void; onDelete: () => void }) {
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
      const MENU_H = 108; // ~3 items * ~32px + padding/border; close enough for flip
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
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'inherit', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 3,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="3.5" cy="8" r="1.2" />
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="12.5" cy="8" r="1.2" />
        </svg>
      </button>
      {open && pos && createPortal(
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
          <Box my="1" h="1px" bg="#30363d" />
          {item('Delete', onDelete, true)}
        </Box>,
        document.body,
      )}
    </>
  );
}

function BlockActionIcon({ title, onClick, children }: { title: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: 'inherit', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
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
      fontSize="13px"
      color="#484f58"
      flexShrink="0"
      minW="0"
    >
      <Box className="grove-sq-loader" aria-label="running">
        <span /><span /><span /><span />
      </Box>
      <Box as="span" truncate maxW="360px">{truncated}</Box>
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
  const groupCwd = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    return tab ? s.groups.find((g) => g.id === tab.groupId)?.cwd : undefined;
  });
  const cwd = ctx?.shortCwd || groupCwd || '~';
  return (
    <HStack px="4" pt="4" pb="0" gap="2" bg="#010409" flexWrap="wrap">
      <Chip icon={<FolderIcon />} label={cwd} />
      {ctx?.node && (
        <Chip icon={<NodeIcon />} label={ctx.node} labelColor="#7ee787" />
      )}
      {ctx?.branch && (
        <Chip icon={<BranchIcon />} label={ctx.branch} labelColor="#7ee787" />
      )}
      {ctx?.diff && ctx.diff.files > 0 && (
        <Chip
          icon={<DiffIcon />}
          label={<DiffLabel added={ctx.diff.added} removed={ctx.diff.removed} />}
        />
      )}
      {ctx?.pr && <PrChip pr={ctx.pr} />}
      {ctx?.env?.venv && <Chip prefix="venv" label={ctx.env.venv} labelColor="#79c0ff" />}
      {ctx?.env?.conda && <Chip prefix="conda" label={ctx.env.conda} labelColor="#d2a8ff" />}
      {ctx?.env?.aws && <Chip prefix="aws" label={ctx.env.aws} labelColor="#f59e0b" />}
      {ctx?.env?.k8s && <Chip prefix="k8s" label={ctx.env.k8s} labelColor="#56d4dd" />}
    </HStack>
  );
}

function Chip({ icon, prefix, label, labelColor }: {
  icon?: React.ReactNode; prefix?: string; label: React.ReactNode; labelColor?: string;
}) {
  return (
    <HStack
      gap="1.5"
      px="2"
      h="22px"
      bg="#0d1117"
      border="1px solid #21262d"
      borderRadius="5px"
      align="center"
      lineHeight="1"
    >
      {icon && (
        <Box
          color={labelColor ?? '#7d8590'}
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="12px"
          h="12px"
        >
          {icon}
        </Box>
      )}
      {prefix && (
        <Text fontSize="12px" color="#7d8590" fontFamily="var(--grove-mono)" fontWeight="600" lineHeight="1" textTransform="lowercase">
          {prefix}
        </Text>
      )}
      <Text fontSize="12px" color={labelColor ?? '#c9d1d9'} fontFamily="var(--grove-mono)" fontWeight="500" lineHeight="1">
        {label}
      </Text>
    </HStack>
  );
}

function CompletionDropdown({
  items, selectedIndex, onPick, onHover,
}: {
  items: CompletionItem[];
  selectedIndex: number;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
}) {
  const kindLabel: Record<CompletionItem['kind'], string> = {
    dir: 'Directory', file: 'File', branch: 'Branch', script: 'Script',
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
            onMouseDown={(e) => { e.preventDefault(); onPick(i); }}
          >
            <Box color={isSel ? '#ffffff' : '#7d8590'} display="flex" alignItems="center">
              {item.kind === 'dir' && <FolderIcon />}
              {item.kind === 'file' && <FileIcon />}
              {item.kind === 'branch' && <BranchIcon />}
              {item.kind === 'script' && <ScriptIcon />}
            </Box>
            <Text fontFamily="var(--grove-mono)" fontSize="13px" fontWeight={isSel ? '600' : '500'} flex="1" truncate>
              {item.label}
            </Text>
            <Text fontFamily="var(--grove-mono)" fontSize="12px" color={isSel ? '#cce0ff' : '#7d8590'}>
              {kindLabel[item.kind]}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="13" viewBox="0 0 12 14" fill="none">
      <path d="M2 1h5l3 3v9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1" />
      <path d="M7 1v3h3" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function ScriptIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <path d="M3 4l3 3-3 3M7 11h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NodeIcon() {
  return (
    <svg width="11" height="12" viewBox="0 0 11 12" fill="none">
      <path d="M5.5 0.5L10.5 3.25v5.5L5.5 11.5L0.5 8.75v-5.5L5.5 0.5z" stroke="#7ee787" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="11" viewBox="0 0 14 12" fill="none">
      <path d="M1 2.5a1 1 0 0 1 1-1h3.5l1.5 1.5h5a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
      <circle cx="2" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <circle cx="2" cy="9.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <circle cx="8" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <path d="M2 3.7v4.6M2 6c0-1.7 1.4-3.5 6-3.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function DiffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor">
      <path
        d="M3 1h5l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M8 1v3h3" strokeWidth="1" />
      <path d="M5 7.5h4M7 5.5v4" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M5 11h4" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function PrChip({ pr }: { pr: NonNullable<TabContext['pr']> }) {
  const color = pr.draft
    ? '#8b949e'
    : pr.state === 'MERGED' ? '#d2a8ff'
    : pr.state === 'CLOSED' ? '#f85149'
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
      title={`${pr.draft ? 'Draft ' : ''}${pr.state}: ${pr.title || `#${pr.number}`}`}
    >
      <Chip
        icon={<PrIcon />}
        label={`#${pr.number}${pr.draft ? ' draft' : ''}`}
        labelColor={color}
      />
    </Box>
  );
}

function PrIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="3.5" cy="3" r="1.3" />
      <circle cx="3.5" cy="11" r="1.3" />
      <circle cx="10.5" cy="11" r="1.3" />
      <path d="M3.5 4.3v5.4" />
      <path d="M10.5 9.7V6a2 2 0 0 0-2-2H7" />
      <path d="M8.5 2.5L7 4l1.5 1.5" />
    </svg>
  );
}
