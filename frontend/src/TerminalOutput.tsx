import { Fragment, useMemo } from 'react';
import { useStore } from './store';
import { API_BASE } from './api';

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

function sgrToClass(codes: number[]): string {
  if (codes.length === 0) return '';
  const classes: string[] = [];
  for (const c of codes) {
    if (c === 1) classes.push('ansi-bold');
    else if (c === 3) classes.push('ansi-italic');
    else if (c === 4) classes.push('ansi-underline');
    else if (c >= 30 && c <= 37) classes.push(`ansi-${COLORS[c - 30]}-fg`);
    else if (c >= 90 && c <= 97) classes.push(`ansi-bright-${COLORS[c - 90]}-fg`);
    else if (c >= 40 && c <= 47) classes.push(`ansi-${COLORS[c - 40]}-bg`);
    else if (c >= 100 && c <= 107) classes.push(`ansi-bright-${COLORS[c - 100]}-bg`);
  }
  return classes.join(' ');
}

function applySgr(prev: number[], params: string): number[] {
  const codes = params ? params.split(';').map((s) => parseInt(s, 10) || 0) : [0];
  if (codes.length === 1 && codes[0] === 0) return [];
  // Reset codes inside the sequence wipe state, then re-apply the rest.
  let out = prev.slice();
  for (const c of codes) {
    if (c === 0) out = [];
    else out.push(c);
  }
  return out;
}

interface Seg { cls: string; text: string; url: string | null }

function parseSegments(raw: string): Seg[] {
  const segs: Seg[] = [];
  let sgr: number[] = [];
  let url: string | null = null;
  let buf = '';
  let cls = '';
  const flush = () => {
    if (!buf) return;
    segs.push({ cls, text: buf, url });
    buf = '';
  };
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\x1b' && raw[i + 1] === '[') {
      let j = i + 2;
      while (j < raw.length && /[0-9;?]/.test(raw[j])) j++;
      const final = raw[j];
      if (final === 'm') {
        flush();
        sgr = applySgr(sgr, raw.slice(i + 2, j));
        cls = sgrToClass(sgr);
      }
      i = j + 1;
    } else if (ch === '\x1b' && raw[i + 1] === ']' && raw[i + 2] === '8' && raw[i + 3] === ';') {
      // OSC 8 ; params ; URL ST
      const stIdx = raw.indexOf('\x1b\\', i + 4);
      const belIdx = raw.indexOf('\x07', i + 4);
      let end: number;
      let termLen: number;
      if (stIdx !== -1 && (belIdx === -1 || stIdx < belIdx)) { end = stIdx; termLen = 2; }
      else if (belIdx !== -1) { end = belIdx; termLen = 1; }
      else { i++; continue; }
      const inner = raw.slice(i + 4, end);
      const semi = inner.indexOf(';');
      const nextUrl = semi >= 0 ? inner.slice(semi + 1) : '';
      flush();
      url = nextUrl || null;
      i = end + termLen;
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

function urlToPath(url: string): string {
  if (url.startsWith('file://')) {
    let p = url.replace(/^file:\/\/[^/]*/, '');
    try { p = decodeURIComponent(p); } catch {}
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
  // HTTP(S) URLs route to the embedded browser panel, never the file browser.
  if (HTTP_URL_WORD.test(cleanedRaw)) {
    const store = useStore.getState();
    store.setBrowserPanelUrl(cleanedRaw);
    if (!store.browserPanelOpen) store.toggleBrowserPanel();
    return;
  }
  let p = urlToPath(rawTarget);
  p = cleanToken(p);
  p = p.replace(/[#?].*$/, '');
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
    useStore.getState().openFileInBrowser(json.abs, kind);
  } catch (err) {
    console.error('[grove] file resolve failed', err);
  }
}

// Detected-as-path tokens: always-on dotted underline so they read as links.
function PathLink({ href, cls, cwd, children }: { href: string; cls: string; cwd: string; children: React.ReactNode }) {
  return (
    <span
      className={`${cls} grove-output-link`}
      title={`${href} — ⌘-click to open`}
      style={{
        cursor: 'pointer',
        textDecoration: 'underline',
        textDecorationStyle: 'dotted',
        textDecorationColor: '#3d4147',
      }}
      onClick={(e) => onLinkClick(e, href, cwd)}
    >
      {children}
    </span>
  );
}

// Plain words: no decoration at rest, but light up on ⌘-hover so the user
// sees what they're about to verify+open.
function WordCandidate({ word, cls, cwd, children }: { word: string; cls: string; cwd: string; children: React.ReactNode }) {
  return (
    <span
      className={`${cls} grove-output-word`}
      onClick={(e) => onLinkClick(e, word, cwd)}
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

export function TerminalOutput({ text, cwd }: { text: string; cwd: string }) {
  const nodes = useMemo(() => {
    const segs = parseSegments(text);
    const out: React.ReactNode[] = [];
    let key = 0;
    for (const s of segs) {
      if (s.url) {
        // Explicit OSC 8 link — render whole segment as one clickable span.
        out.push(
          <PathLink key={key++} href={s.url} cls={s.cls} cwd={cwd}>
            {s.text}
          </PathLink>,
        );
        continue;
      }
      // Walk the segment word-by-word so each token can independently light
      // up on ⌘-hover. Whitespace stays in a plain span so wrapping/breaks
      // still work naturally.
      let i = 0;
      while (i < s.text.length) {
        const isWs = /\s/.test(s.text[i]);
        let j = i + 1;
        while (j < s.text.length && /\s/.test(s.text[j]) === isWs) j++;
        const chunk = s.text.slice(i, j);
        if (isWs) {
          out.push(<span key={key++} className={s.cls}>{chunk}</span>);
        } else {
          const stripped = cleanToken(chunk);
          if (stripped && (PATH_LIKE_WORD.test(stripped) || HTTP_URL_WORD.test(stripped))) {
            out.push(<PathLink key={key++} href={stripped} cls={s.cls} cwd={cwd}>{chunk}</PathLink>);
          } else if (stripped) {
            out.push(<WordCandidate key={key++} word={stripped} cls={s.cls} cwd={cwd}>{chunk}</WordCandidate>);
          } else {
            out.push(<span key={key++} className={s.cls}>{chunk}</span>);
          }
        }
        i = j;
      }
    }
    return out;
  }, [text, cwd]);
  return <Fragment>{nodes}</Fragment>;
}
