import React, { Fragment, useMemo } from 'react';
import { useStore } from './store';
import { API_BASE } from './api';
import { dispatch } from './extensions/actions';
import { isLocalUrl } from './urlRouting';

// Renderer for terminal block output.
//
// Handles three concerns at once:
//   1. ANSI SGR colors/bold/etc. (the bits ansi-to-react gave us before).
//   2. OSC 8 hyperlinks emitted by modern tools — `\e]8;;url\e\\text\e]8;;\e\\`
//      becomes a clickable span.
//   3. Heuristic path detection over plain text — `src/App.tsx:10:5` and
//      friends become clickable even when the emitter doesn't use OSC 8.
//
// Cmd/Ctrl-click on a link opens the path in the file browser. Regular click
// behaves like text (selectable, no jump) so accidental drags don't navigate.

const COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

type ColorSpec =
  | { kind: 'basic'; idx: number; bright: boolean }
  | { kind: 'rgb'; r: number; g: number; b: number };

interface SgrState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
  fg: ColorSpec | null;
  bg: ColorSpec | null;
}

const EMPTY_SGR: SgrState = {
  bold: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
  fg: null,
  bg: null,
};

// xterm 256-color cube: 16-231 are a 6x6x6 cube, 232-255 are grayscale.
function index256ToRgb(n: number): { r: number; g: number; b: number } {
  if (n < 16) {
    // 0-7 basic, 8-15 bright. Caller handles these via class names normally;
    // this fallback is only used if 38;5;0-15 slips through.
    const basic = [
      [0, 0, 0],
      [205, 49, 49],
      [13, 188, 121],
      [229, 229, 16],
      [36, 114, 200],
      [188, 63, 188],
      [17, 168, 205],
      [229, 229, 229],
      [102, 102, 102],
      [255, 123, 114],
      [126, 231, 135],
      [227, 179, 65],
      [121, 192, 255],
      [210, 168, 255],
      [86, 212, 221],
      [240, 246, 252],
    ];
    const [r, g, b] = basic[n];
    return { r, g, b };
  }
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return { r: steps[Math.floor(i / 36) % 6], g: steps[Math.floor(i / 6) % 6], b: steps[i % 6] };
  }
  const v = 8 + (n - 232) * 10;
  return { r: v, g: v, b: v };
}

function colorToCss(c: ColorSpec): string {
  if (c.kind === 'rgb') return `rgb(${c.r},${c.g},${c.b})`;
  // basic kind is converted to a class instead; this branch is unused for now.
  return '';
}

function sgrToClassAndStyle(s: SgrState): { cls: string; style: React.CSSProperties | undefined } {
  const classes: string[] = [];
  const style: React.CSSProperties = {};
  if (s.bold) classes.push('ansi-bold');
  if (s.italic) classes.push('ansi-italic');
  if (s.underline) classes.push('ansi-underline');
  if (s.strike) classes.push('ansi-strikethrough');
  const fg = s.inverse ? s.bg : s.fg;
  const bg = s.inverse ? s.fg : s.bg;
  if (fg) {
    if (fg.kind === 'basic') classes.push(`ansi-${fg.bright ? 'bright-' : ''}${COLORS[fg.idx]}-fg`);
    else style.color = colorToCss(fg);
  }
  if (bg) {
    if (bg.kind === 'basic') classes.push(`ansi-${bg.bright ? 'bright-' : ''}${COLORS[bg.idx]}-bg`);
    else style.background = colorToCss(bg);
  }
  const cls = classes.join(' ');
  const hasStyle = style.color !== undefined || style.background !== undefined;
  return { cls, style: hasStyle ? style : undefined };
}

function applySgr(prev: SgrState, params: string): SgrState {
  const codes = params ? params.split(';').map((s) => parseInt(s, 10) || 0) : [0];
  const out: SgrState = { ...prev };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) {
      Object.assign(out, EMPTY_SGR);
    } else if (c === 1) out.bold = true;
    else if (c === 3) out.italic = true;
    else if (c === 4) out.underline = true;
    else if (c === 7) out.inverse = true;
    else if (c === 9) out.strike = true;
    else if (c === 22) out.bold = false;
    else if (c === 23) out.italic = false;
    else if (c === 24) out.underline = false;
    else if (c === 27) out.inverse = false;
    else if (c === 29) out.strike = false;
    else if (c >= 30 && c <= 37) out.fg = { kind: 'basic', idx: c - 30, bright: false };
    else if (c === 38) {
      // 38;5;N or 38;2;R;G;B — consume sub-params.
      const sub = codes[i + 1];
      if (sub === 5 && i + 2 < codes.length) {
        const n = codes[i + 2];
        if (n < 16) out.fg = { kind: 'basic', idx: n & 7, bright: n >= 8 };
        else {
          const { r, g, b } = index256ToRgb(n);
          out.fg = { kind: 'rgb', r, g, b };
        }
        i += 2;
      } else if (sub === 2 && i + 4 < codes.length) {
        out.fg = { kind: 'rgb', r: codes[i + 2], g: codes[i + 3], b: codes[i + 4] };
        i += 4;
      }
    } else if (c === 39) out.fg = null;
    else if (c >= 40 && c <= 47) out.bg = { kind: 'basic', idx: c - 40, bright: false };
    else if (c === 48) {
      const sub = codes[i + 1];
      if (sub === 5 && i + 2 < codes.length) {
        const n = codes[i + 2];
        if (n < 16) out.bg = { kind: 'basic', idx: n & 7, bright: n >= 8 };
        else {
          const { r, g, b } = index256ToRgb(n);
          out.bg = { kind: 'rgb', r, g, b };
        }
        i += 2;
      } else if (sub === 2 && i + 4 < codes.length) {
        out.bg = { kind: 'rgb', r: codes[i + 2], g: codes[i + 3], b: codes[i + 4] };
        i += 4;
      }
    } else if (c === 49) out.bg = null;
    else if (c >= 90 && c <= 97) out.fg = { kind: 'basic', idx: c - 90, bright: true };
    else if (c >= 100 && c <= 107) out.bg = { kind: 'basic', idx: c - 100, bright: true };
  }
  return out;
}

interface Seg {
  cls: string;
  style: React.CSSProperties | undefined;
  text: string;
  url: string | null;
}

function parseSegments(raw: string): Seg[] {
  const segs: Seg[] = [];
  let sgr: SgrState = { ...EMPTY_SGR };
  let url: string | null = null;
  let buf = '';
  let cls = '';
  let style: React.CSSProperties | undefined = undefined;
  const flush = () => {
    if (!buf) return;
    segs.push({ cls, style, text: buf, url });
    buf = '';
  };
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\x1b' && raw[i + 1] === '[') {
      // CSI: ESC [ params final. Consume params (digits, ;, ?, <, >, =, !, ", ', $, *)
      // plus the final byte. Only `m` produces a visible effect (SGR); everything
      // else (cursor moves, mode toggles) is silently skipped.
      let j = i + 2;
      while (j < raw.length && /[\x30-\x3f]/.test(raw[j])) j++;
      while (j < raw.length && /[\x20-\x2f]/.test(raw[j])) j++;
      const final = raw[j];
      if (final === 'm') {
        flush();
        sgr = applySgr(sgr, raw.slice(i + 2, j));
        ({ cls, style } = sgrToClassAndStyle(sgr));
      } else if (final === 'C') {
        // CUF — cursor forward N columns. xterm's SerializeAddon emits this
        // (and `[NX]`) instead of literal spaces to compress runs of blank
        // cells. We render snapshots inside a `white-space: pre` block, so
        // the only way for those gaps to survive is to inflate the cursor
        // move into actual spaces. Without this, "Welcome back Arthur!" in a
        // raw-mode snapshot renders as "WelcomebackArthur!".
        const params = raw.slice(i + 2, j);
        const n = params === '' ? 1 : parseInt(params, 10) || 1;
        buf += ' '.repeat(Math.min(n, 1000));
      }
      // Other CSI finals (X = erase-char, A/B/D = cursor moves, K/J = erase
      // in line/display, etc.) are no-ops for snapshot rendering: any visible
      // gap they create is already covered by the paired CUF above.
      i = j + 1;
    } else if (ch === '\x1b' && raw[i + 1] === ']' && raw[i + 2] === '8' && raw[i + 3] === ';') {
      // OSC 8 ; params ; URL ST
      const stIdx = raw.indexOf('\x1b\\', i + 4);
      const belIdx = raw.indexOf('\x07', i + 4);
      let end: number;
      let termLen: number;
      if (stIdx !== -1 && (belIdx === -1 || stIdx < belIdx)) {
        end = stIdx;
        termLen = 2;
      } else if (belIdx !== -1) {
        end = belIdx;
        termLen = 1;
      } else {
        i++;
        continue;
      }
      const inner = raw.slice(i + 4, end);
      const semi = inner.indexOf(';');
      const nextUrl = semi >= 0 ? inner.slice(semi + 1) : '';
      flush();
      url = nextUrl || null;
      i = end + termLen;
    } else if (ch === '\x1b' && raw[i + 1] === ']') {
      // Other OSC sequences (title, hyperlinks we don't handle, etc.) — skip
      // through ST (ESC \) or BEL.
      const stIdx = raw.indexOf('\x1b\\', i + 2);
      const belIdx = raw.indexOf('\x07', i + 2);
      let end = -1;
      let termLen = 0;
      if (stIdx !== -1 && (belIdx === -1 || stIdx < belIdx)) {
        end = stIdx;
        termLen = 2;
      } else if (belIdx !== -1) {
        end = belIdx;
        termLen = 1;
      }
      if (end === -1) {
        i++;
      } else {
        i = end + termLen;
      }
    } else if (ch === '\x1b' && raw[i + 1] === 'P') {
      // DCS (Device Control String) — terminated by ST.
      const stIdx = raw.indexOf('\x1b\\', i + 2);
      i = stIdx === -1 ? raw.length : stIdx + 2;
    } else if (ch === '\x1b' && raw.length > i + 1) {
      // Two-byte ESC sequences: charset selects (ESC ( B), keypad modes
      // (ESC =, ESC >), cursor save/restore (ESC 7, ESC 8), etc. We don't
      // need to act on them; just skip both bytes so the second byte doesn't
      // leak into the visible output.
      const next = raw[i + 1];
      // Charset designators take an extra byte: ESC ( B, ESC ) 0, etc.
      if ('()*+-./'.includes(next)) i += 3;
      else i += 2;
    } else {
      buf += ch;
      i++;
    }
  }
  flush();
  return segs;
}

// A "path-ish" word that should always render with a visible link decoration:
// has at least one `/` segment, optional `:line:col`.
const PATH_LIKE_WORD = /^(?:\.{1,2}\/|~\/|\/)?(?:[\w.-]+\/)+[\w.-]+(?::\d+(?::\d+)?)?$/;

// HTTP(S) URL detection — clicked tokens skip filesystem resolve and open in
// the embedded browser panel instead.
const HTTP_URL_WORD = /^https?:\/\/[^\s<>"']+$/i;

function stripLineCol(p: string): string {
  return p.replace(/:\d+(?::\d+)?$/, '');
}

function parseLineCol(p: string): { line?: number; col?: number } {
  const m = p.match(/:(\d+)(?::(\d+))?$/);
  if (!m) return {};
  const line = parseInt(m[1], 10);
  const col = m[2] ? parseInt(m[2], 10) : undefined;
  return {
    line: Number.isFinite(line) && line >= 1 ? line : undefined,
    col: col !== undefined && Number.isFinite(col) && col >= 1 ? col : undefined,
  };
}

function urlToPath(url: string): string {
  if (url.startsWith('file://')) {
    let p = url.replace(/^file:\/\/[^/]*/, '');
    try {
      p = decodeURIComponent(p);
    } catch {}
    return p;
  }
  return url;
}

const PUNCT_HEAD_RE = /^[<("'`[]+/;
const PUNCT_TAIL_RE = /[>)"'`\],;.!?]+$/;

function cleanToken(s: string): string {
  return s.replace(PUNCT_HEAD_RE, '').replace(PUNCT_TAIL_RE, '');
}

async function openLink(rawTarget: string, blockCwd: string) {
  const cleanedRaw = cleanToken(rawTarget);
  if (HTTP_URL_WORD.test(cleanedRaw)) {
    if (isLocalUrl(cleanedRaw)) {
      dispatch('open-url', { url: cleanedRaw });
    } else {
      window.grove?.openExternal?.(cleanedRaw);
    }
    return;
  }
  let p = urlToPath(rawTarget);
  p = cleanToken(p);
  p = p.replace(/[#?].*$/, '');
  // Capture `:line:col` before stripping it for the filesystem resolve, so a
  // click on `src/checkout.tsx:42:18` lands the editor at that exact spot.
  const { line, col } = parseLineCol(p);
  p = stripLineCol(p);
  if (!p) return;
  try {
    const params = new URLSearchParams({ path: p, cwd: blockCwd });
    const activeTabId = useStore.getState().activeTabId;
    if (activeTabId) params.set('tabId', activeTabId);
    const res = await fetch(`${API_BASE}/file/resolve?${params.toString()}`);
    const json = await res.json();
    if (!json.exists) return;
    const kind: 'file' | 'dir' = json.isDir ? 'dir' : 'file';
    dispatch('open-file', { path: json.abs, kind, line, col });
  } catch (err) {
    console.error('[grove] file resolve failed', err);
  }
}

// Double-click a detected link/path token to select the WHOLE token. Native
// double-click stops at `/` and `-` word boundaries, so a path like
// update/opt-in-welcome-rollout-cohort would only select one segment. A single
// logical token may render as several sibling spans (one per SGR slice); they
// share a `data-link-group` id so we can span the full run in one selection.
function selectLinkToken(e: React.MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const group = el.dataset.linkGroup;
  const parent = el.parentElement;
  if (group == null || !parent) return;
  const pieces = parent.querySelectorAll(`[data-link-group="${CSS.escape(group)}"]`);
  if (pieces.length === 0) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartBefore(pieces[0]);
  range.setEndAfter(pieces[pieces.length - 1]);
  sel.removeAllRanges();
  sel.addRange(range);
  // Replace native word-boundary selection with our whole-token one.
  e.preventDefault();
}

// Detected-as-path tokens: always-on dotted underline so they read as links.
function PathLink({
  href,
  cls,
  style,
  cwd,
  group,
  children,
}: {
  href: string;
  cls: string;
  style?: React.CSSProperties;
  cwd: string;
  group?: number;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`${cls} grove-output-link`}
      title={`${href} — ⌘-click to open`}
      data-link-group={group}
      style={{
        ...style,
        cursor: 'pointer',
        textDecoration: 'underline',
        textDecorationStyle: 'dotted',
        textDecorationColor: '#3d4147',
      }}
      onClick={(e) => onLinkClick(e, href, cwd)}
      onDoubleClick={selectLinkToken}
    >
      {children}
    </span>
  );
}

// Plain words: no decoration at rest, but light up on ⌘-hover so the user
// sees what they're about to verify+open.
function WordCandidate({
  word,
  cls,
  style,
  cwd,
  group,
  children,
}: {
  word: string;
  cls: string;
  style?: React.CSSProperties;
  cwd: string;
  group?: number;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`${cls} grove-output-word`}
      style={style}
      data-link-group={group}
      onClick={(e) => onLinkClick(e, word, cwd)}
      onDoubleClick={selectLinkToken}
    >
      {children}
    </span>
  );
}

function onLinkClick(e: React.MouseEvent, href: string, cwd: string) {
  if (!(e.metaKey || e.ctrlKey)) return;
  const sel = window.getSelection();
  if (sel && sel.toString()) return;
  e.preventDefault();
  e.stopPropagation();
  openLink(href, cwd);
}

// One styled slice of a word. Multiple pieces with differing SGR may make up
// a single logical word when SerializeAddon split the URL across cells.
interface Piece {
  cls: string;
  style: React.CSSProperties | undefined;
  text: string;
}

export function TerminalOutput({ text, cwd }: { text: string; cwd: string }) {
  const nodes = useMemo(() => {
    const segs = parseSegments(text);
    const out: React.ReactNode[] = [];
    let key = 0;
    // Buffered run of non-whitespace pieces that may span SGR changes — we
    // can't classify them as URL/path/word until we hit whitespace and know
    // the full token.
    let wordPieces: Piece[] = [];
    // Per-token id shared across a token's SGR slices so a double-click can
    // select the whole run (see selectLinkToken).
    let wordGroup = 0;
    const flushWord = () => {
      if (wordPieces.length === 0) return;
      const joined = wordPieces.map((p) => p.text).join('');
      const stripped = cleanToken(joined);
      const group = wordGroup++;
      if (stripped && (PATH_LIKE_WORD.test(stripped) || HTTP_URL_WORD.test(stripped))) {
        for (const p of wordPieces) {
          out.push(
            <PathLink
              key={key++}
              href={stripped}
              cls={p.cls}
              style={p.style}
              cwd={cwd}
              group={group}
            >
              {p.text}
            </PathLink>,
          );
        }
      } else if (stripped) {
        for (const p of wordPieces) {
          out.push(
            <WordCandidate
              key={key++}
              word={stripped}
              cls={p.cls}
              style={p.style}
              cwd={cwd}
              group={group}
            >
              {p.text}
            </WordCandidate>,
          );
        }
      } else {
        for (const p of wordPieces) {
          out.push(
            <span key={key++} className={p.cls} style={p.style}>
              {p.text}
            </span>,
          );
        }
      }
      wordPieces = [];
    };
    for (const s of segs) {
      if (s.url) {
        // Explicit OSC 8 link — flush any pending word, then render the whole
        // segment as one clickable span.
        flushWord();
        out.push(
          <PathLink
            key={key++}
            href={s.url}
            cls={s.cls}
            style={s.style}
            cwd={cwd}
            group={wordGroup++}
          >
            {s.text}
          </PathLink>,
        );
        continue;
      }
      let i = 0;
      while (i < s.text.length) {
        const isWs = /\s/.test(s.text[i]);
        let j = i + 1;
        while (j < s.text.length && /\s/.test(s.text[j]) === isWs) j++;
        const chunk = s.text.slice(i, j);
        if (isWs) {
          flushWord();
          out.push(
            <span key={key++} className={s.cls} style={s.style}>
              {chunk}
            </span>,
          );
        } else {
          wordPieces.push({ cls: s.cls, style: s.style, text: chunk });
        }
        i = j;
      }
    }
    flushWord();
    return out;
  }, [text, cwd]);
  return <Fragment>{nodes}</Fragment>;
}
