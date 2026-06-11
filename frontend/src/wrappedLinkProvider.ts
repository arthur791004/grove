// Custom xterm link provider that handles URLs spanning multiple rows.
//
// Why not `@xterm/addon-web-links`: it joins rows only when xterm's own soft-
// wrap set `isWrapped` on the continuation. TUIs like claude, less, and our
// own ?1049h alt-screen apps print wrapped URLs via explicit cursor moves
// instead of letting xterm soft-wrap them — none of those continuations are
// flagged `isWrapped`, so the addon stops at the first row and Cmd-click only
// opens that row's truncated substring.
//
// Strategy: walk back and forward from the hovered row to build a "logical
// line", joining both isWrapped continuations AND consecutive rows whose
// boundary looks mid-URL (no whitespace gap, both touching chars are URL-
// allowed). Run a URL regex on the concat, map matches back to per-row
// IBufferRange — xterm renders multi-row link underlines and fires a single
// `activate` for the whole match.

import type { ILinkProvider, ILink, Terminal, IBuffer } from '@xterm/xterm';

// Same pattern WebLinksAddon ships, modulo the redundant uppercase alternation.
// Greedy until a URL-terminating character. Trailing punctuation that's almost
// always sentence noise (`.`, `,`, `!`, `?`, `;`, `:`, closing brackets) is
// shaved off by the trailing class.
const URL_RE = /https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/g;

// Characters allowed inside a URL after the scheme. Used by the cross-boundary
// heuristic so we only stitch rows when both sides clearly continue a URL.
function isUrlChar(ch: string): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  // ASCII letters/digits + URL-reserved/unreserved punctuation that commonly
  // appears mid-URL. Tabs, spaces, quotes — explicitly out.
  if (c >= 33 && c <= 126) {
    return ch !== ' ' && ch !== '"' && ch !== "'" && ch !== '<' && ch !== '>' && ch !== '`';
  }
  return false;
}

// Pull a row's text, trimmed of trailing spaces so a row that's only half-full
// doesn't drag pages of spaces into the concat. WebLinksAddon does the same.
function rowText(buffer: IBuffer, y: number): string {
  const line = buffer.getLine(y);
  if (!line) return '';
  return line.translateToString(true);
}

// Walk back from `y` while the boundary looks like a single logical line. A
// boundary is a join if either:
//   - the row at `y` reports isWrapped (xterm soft-wrap), or
//   - the row above ends in a URL-char with no trailing space AND the row at
//     `y` starts with a URL-char (no leading space) — TUI-style continuation.
function findLogicalStart(buffer: IBuffer, y: number, maxRows: number): number {
  let cur = y;
  while (cur > 0 && y - cur < maxRows) {
    const here = buffer.getLine(cur);
    if (!here) break;
    const prev = buffer.getLine(cur - 1);
    if (!prev) break;
    if (here.isWrapped) {
      cur--;
      continue;
    }
    const prevText = prev.translateToString(true);
    const hereText = here.translateToString(true);
    if (
      prevText.length > 0 &&
      hereText.length > 0 &&
      isUrlChar(prevText[prevText.length - 1]) &&
      isUrlChar(hereText[0])
    ) {
      cur--;
      continue;
    }
    break;
  }
  return cur;
}

function findLogicalEnd(buffer: IBuffer, y: number, maxRows: number): number {
  let cur = y;
  while (cur < buffer.length - 1 && cur - y < maxRows) {
    const next = buffer.getLine(cur + 1);
    if (!next) break;
    if (next.isWrapped) {
      cur++;
      continue;
    }
    const curLine = buffer.getLine(cur);
    if (!curLine) break;
    const curText = curLine.translateToString(true);
    const nextText = next.translateToString(true);
    if (
      curText.length > 0 &&
      nextText.length > 0 &&
      isUrlChar(curText[curText.length - 1]) &&
      isUrlChar(nextText[0])
    ) {
      cur++;
      continue;
    }
    break;
  }
  return cur;
}

export function wrappedLinkProvider(
  term: Terminal,
  handler: (event: MouseEvent, uri: string) => void,
): ILinkProvider {
  // Cap walks at one viewport's worth of rows on each side — a URL that takes
  // 50 wrapped rows is almost certainly garbage we shouldn't try to follow.
  const MAX_ROW_WALK = 50;
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active;
      const y = bufferLineNumber - 1;
      const line = buffer.getLine(y);
      if (!line) {
        callback(undefined);
        return;
      }
      const startY = findLogicalStart(buffer, y, MAX_ROW_WALK);
      const endY = findLogicalEnd(buffer, y, MAX_ROW_WALK);

      // Build the concat plus a parallel array of per-row text lengths so we
      // can map a flat string offset back to (row, col).
      const rowLengths: number[] = [];
      let concat = '';
      for (let r = startY; r <= endY; r++) {
        const t = rowText(buffer, r);
        rowLengths.push(t.length);
        concat += t;
      }
      if (!concat) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      const re = new RegExp(URL_RE.source, URL_RE.flags);
      const hoveredRowIdx = y - startY;
      let m: RegExpExecArray | null;
      while ((m = re.exec(concat)) !== null) {
        const text = m[0];
        const startOff = m.index;
        const endOff = startOff + text.length - 1; // inclusive last char

        // Map offset → (rowIdx, col) using cumulative row lengths.
        let acc = 0;
        let startRowIdx = -1;
        let startCol = 0;
        for (let i = 0; i < rowLengths.length; i++) {
          const next = acc + rowLengths[i];
          if (startOff < next) {
            startRowIdx = i;
            startCol = startOff - acc;
            break;
          }
          acc = next;
        }
        acc = 0;
        let endRowIdx = -1;
        let endCol = 0;
        for (let i = 0; i < rowLengths.length; i++) {
          const next = acc + rowLengths[i];
          if (endOff < next) {
            endRowIdx = i;
            endCol = endOff - acc;
            break;
          }
          acc = next;
        }
        if (startRowIdx === -1 || endRowIdx === -1) continue;
        if (hoveredRowIdx < startRowIdx || hoveredRowIdx > endRowIdx) continue;

        // xterm's IBufferRange is 1-based; end.x is inclusive of the last cell.
        const range = {
          start: { x: startCol + 1, y: startY + startRowIdx + 1 },
          end: { x: endCol + 1, y: startY + endRowIdx + 1 },
        };
        links.push({
          range,
          text,
          activate(event, uri) {
            handler(event, uri);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}
