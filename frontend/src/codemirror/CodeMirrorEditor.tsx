// Single-instance read-only editor used by the Files panel. The EditorView is
// mounted once per <CodeMirrorEditor>; subsequent file opens swap the document
// + language via a Compartment instead of remounting (avoids flash, preserves
// scroll-position history).
//
// Public surface: an imperative API exposed via ref, plus an updateListener
// that surfaces cursor position for the host's status bar.

import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Box } from '@chakra-ui/react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { groveTheme, groveHighlighting } from './theme';
import {
  setTargetLine,
  targetLineField,
  setClaudeEdit,
  claudeEditField,
  setAiOverlay,
  aiOverlayField,
  type AiOverlay,
} from './decorations';
import { detectCmLanguage } from './language-detect';

export interface CursorPosition {
  line: number;
  col: number;
}

export interface OpenFileOptions {
  path: string;
  content: string;
  line?: number;
  col?: number;
  claudeEditRange?: { fromLine: number; toLine: number };
  // Files larger than this many lines skip syntax highlighting to keep the
  // first render responsive. Caller passes the threshold; the editor handles
  // the rest.
  syntaxLineLimit?: number;
  // Restore prior cursor / scroll when re-activating a previously-open tab.
  // line/col (the explicit jump-to path) wins over these when both are set.
  cursorOffset?: number;
  scrollTop?: number;
  // Re-mark the editor as dirty after loading. Used when the cached draft we
  // load is the user's unsaved edits, not the on-disk content.
  dirty?: boolean;
}

export interface AssistantRequest {
  selectedText: string;
  surroundingLines: string;
  fullContent: string;
  selectionRange: { fromLine: number; toLine: number };
  // Character offsets in the current doc — needed so the caller can later
  // apply Claude's modified text back into exactly the right range.
  selectionOffsets: { from: number; to: number };
  // Pixel anchor (relative to the editor's scroller) for the prompt bar.
  anchorTop: number;
}

export interface CodeMirrorHandle {
  openFile(opts: OpenFileOptions): void;
  clear(): void;
  promptGotoLine(): void;
  openSearch(): void;
  getValue(): string;
  markClean(): void;
  markDirty(): void;
  getCursorOffset(): number;
  getScrollTop(): number;
  // AI overlay controls.
  showAiOverlay(overlay: AiOverlay): void;
  clearAiOverlay(): void;
  applyAiChange(opts: { from: number; to: number; insert: string }): void;
}

interface Props {
  onCursorChange?: (pos: CursorPosition) => void;
  onLanguageChange?: (label: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onAssistantRequest?: (req: AssistantRequest) => void;
}

// Try-import these in case CM6 doesn't expose `commands` in older minor
// versions of the host's transitive deps. We pulled it in via the umbrella
// `codemirror` package so the import above is the canonical path.

const LARGE_FILE_LINES = 5_000;

export const CodeMirrorEditor = forwardRef<CodeMirrorHandle, Props>(function CodeMirrorEditor(
  { onCursorChange, onLanguageChange, onDirtyChange, onAssistantRequest },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartmentRef = useRef<Compartment>(new Compartment());
  const cursorListenerRef = useRef<((p: CursorPosition) => void) | undefined>(onCursorChange);
  const langListenerRef = useRef<((s: string) => void) | undefined>(onLanguageChange);
  const dirtyListenerRef = useRef<((d: boolean) => void) | undefined>(onDirtyChange);
  const assistantListenerRef = useRef<((r: AssistantRequest) => void) | undefined>(
    onAssistantRequest,
  );
  const dirtyRef = useRef(false);
  // True while openFile/clear are swapping the document — doc changes from
  // that swap must not be counted as user edits.
  const loadingRef = useRef(false);
  cursorListenerRef.current = onCursorChange;
  langListenerRef.current = onLanguageChange;
  dirtyListenerRef.current = onDirtyChange;
  assistantListenerRef.current = onAssistantRequest;

  function setDirty(next: boolean) {
    if (dirtyRef.current === next) return;
    dirtyRef.current = next;
    dirtyListenerRef.current?.(next);
  }

  const extensionsRef = useRef<Extension[] | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const langCompartment = langCompartmentRef.current;
    const baseExtensions: Extension[] = [
      lineNumbers(),
      foldGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      indentOnInput(),
      highlightSelectionMatches(),
      history(),
      search({ top: true }),
      keymap.of([
        {
          key: 'Mod-Enter',
          preventDefault: true,
          run: (view) => {
            const handler = assistantListenerRef.current;
            if (!handler) return false;
            const req = buildAssistantRequest(view);
            if (req) handler(req);
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      EditorView.lineWrapping,
      groveTheme,
      groveHighlighting,
      targetLineField,
      claudeEditField,
      aiOverlayField,
      langCompartment.of([]),
      EditorView.updateListener.of((v) => {
        if (v.selectionSet || v.docChanged) {
          const head = v.state.selection.main.head;
          const line = v.state.doc.lineAt(head);
          cursorListenerRef.current?.({
            line: line.number,
            col: head - line.from + 1,
          });
        }
        if (v.docChanged && !loadingRef.current) setDirty(true);
      }),
    ];
    extensionsRef.current = baseExtensions;
    const view = new EditorView({
      state: EditorState.create({ doc: '', extensions: baseExtensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    (): CodeMirrorHandle => ({
      openFile(opts) {
        const view = viewRef.current;
        if (!view) return;
        const langInfo = detectCmLanguage(opts.path);
        const limit = opts.syntaxLineLimit ?? LARGE_FILE_LINES;
        // Cheap line count via newline tally — Doc would need a full
        // insertion before we can ask it.
        const lineCount = countLines(opts.content);
        const langExtension = lineCount > limit ? [] : langInfo.extension;

        // Rebuild the EditorState from scratch so each file gets a fresh
        // history stack — otherwise Cmd+Z can undo past the file-load
        // transaction and land the user in an empty buffer.
        const extensions = extensionsRef.current ?? [];
        loadingRef.current = true;
        view.setState(EditorState.create({ doc: opts.content, extensions }));
        view.dispatch({
          effects: [
            langCompartmentRef.current.reconfigure(langExtension),
            setTargetLine.of(null),
            setClaudeEdit.of(null),
          ],
          selection: { anchor: 0 },
        });
        loadingRef.current = false;
        setDirty(!!opts.dirty);

        // Apply cursor/scroll restore unless line/col is going to override it
        // a few lines below.
        if (!opts.line && typeof opts.cursorOffset === 'number') {
          const docLen = view.state.doc.length;
          const anchor = Math.max(0, Math.min(opts.cursorOffset, docLen));
          view.dispatch({ selection: { anchor } });
        }
        if (typeof opts.scrollTop === 'number') {
          // After the new state mounts: set scrollTop on the next frame so the
          // layout is in place.
          const target = opts.scrollTop;
          requestAnimationFrame(() => {
            const v = viewRef.current;
            if (v) v.scrollDOM.scrollTop = target;
          });
        }

        langListenerRef.current?.(
          lineCount > limit ? `${langInfo.label} (no highlight)` : langInfo.label,
        );

        if (opts.line && opts.line >= 1) {
          const docLines = view.state.doc.lines;
          const targetLine = Math.min(opts.line, docLines);
          const line = view.state.doc.line(targetLine);
          const col = Math.max(1, Math.min(opts.col ?? 1, line.length + 1));
          const pos = line.from + (col - 1);
          view.dispatch({
            selection: { anchor: pos },
            effects: [
              EditorView.scrollIntoView(pos, { y: 'center' }),
              setTargetLine.of({ line: targetLine, fade: false }),
            ],
          });
          // Trigger CSS transition to transparent shortly after the line is
          // painted. Two RAFs give the browser a chance to commit the
          // initial style before the fade class is applied.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const v = viewRef.current;
              if (!v) return;
              v.dispatch({ effects: setTargetLine.of({ line: targetLine, fade: true }) });
            });
          });
          // Clear entirely after the transition completes so the styles
          // don't linger in the decoration set.
          window.setTimeout(() => {
            const v = viewRef.current;
            if (!v) return;
            v.dispatch({ effects: setTargetLine.of(null) });
          }, 2200);
        }

        if (opts.claudeEditRange) {
          view.dispatch({ effects: setClaudeEdit.of(opts.claudeEditRange) });
        }
      },
      clear() {
        const view = viewRef.current;
        if (!view) return;
        const extensions = extensionsRef.current ?? [];
        loadingRef.current = true;
        view.setState(EditorState.create({ doc: '', extensions }));
        view.dispatch({
          effects: [
            langCompartmentRef.current.reconfigure([]),
            setTargetLine.of(null),
            setClaudeEdit.of(null),
          ],
        });
        loadingRef.current = false;
        langListenerRef.current?.('Plain Text');
        setDirty(false);
      },
      getValue() {
        return viewRef.current?.state.doc.toString() ?? '';
      },
      markClean() {
        setDirty(false);
      },
      markDirty() {
        setDirty(true);
      },
      getCursorOffset() {
        return viewRef.current?.state.selection.main.head ?? 0;
      },
      getScrollTop() {
        return viewRef.current?.scrollDOM.scrollTop ?? 0;
      },
      showAiOverlay(overlay) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: setAiOverlay.of(overlay) });
      },
      clearAiOverlay() {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: setAiOverlay.of(null) });
      },
      applyAiChange({ from, to, insert }) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from, to, insert },
          effects: setAiOverlay.of(null),
          selection: { anchor: from + insert.length },
        });
      },
      promptGotoLine() {
        const view = viewRef.current;
        if (!view) return;
        const raw = window.prompt('Go to line');
        if (!raw) return;
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1) return;
        const targetLine = Math.min(n, view.state.doc.lines);
        const line = view.state.doc.line(targetLine);
        view.dispatch({
          selection: { anchor: line.from },
          effects: [
            EditorView.scrollIntoView(line.from, { y: 'center' }),
            setTargetLine.of({ line: targetLine, fade: false }),
          ],
        });
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const v = viewRef.current;
            if (!v) return;
            v.dispatch({ effects: setTargetLine.of({ line: targetLine, fade: true }) });
          });
        });
        window.setTimeout(() => {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({ effects: setTargetLine.of(null) });
        }, 2200);
        view.focus();
      },
      openSearch() {
        const view = viewRef.current;
        if (!view) return;
        // Synthesise Cmd+F so the bundled search panel opens — search's
        // openSearchPanel command isn't exported by the umbrella package
        // in all minor versions, but its keymap is.
        const ev = new KeyboardEvent('keydown', {
          key: 'f',
          code: 'KeyF',
          metaKey: true,
          bubbles: true,
        });
        view.contentDOM.dispatchEvent(ev);
        view.focus();
      },
    }),
    [],
  );

  return <Box ref={hostRef} flex="1" minH="0" minW="0" overflow="hidden" />;
});

function countLines(s: string): number {
  if (!s) return 1;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

const SURROUNDING_LINES = 10;

function buildAssistantRequest(view: EditorView): AssistantRequest | null {
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  // If the selection is collapsed, treat the current line as the implicit
  // selection so ⌘↵ has something to act on.
  let from = sel.from;
  let to = sel.to;
  if (from === to) {
    const line = doc.lineAt(from);
    from = line.from;
    to = line.to;
  }
  if (from === to) return null;

  const fromLine = doc.lineAt(from).number;
  const toLine = doc.lineAt(to).number;
  const surroundFromLine = Math.max(1, fromLine - SURROUNDING_LINES);
  const surroundToLine = Math.min(doc.lines, toLine + SURROUNDING_LINES);
  const surroundFrom = doc.line(surroundFromLine).from;
  const surroundTo = doc.line(surroundToLine).to;

  // Anchor pixel: just below the line containing the selection's tail. Use
  // coordsAtPos which returns viewport-relative coords; the parent translates
  // to its own coordinate system.
  const coords = view.coordsAtPos(to);
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  const anchorTop = coords
    ? coords.bottom - scrollerRect.top + view.scrollDOM.scrollTop + 4
    : 0;

  return {
    selectedText: doc.sliceString(from, to),
    surroundingLines: doc.sliceString(surroundFrom, surroundTo),
    fullContent: doc.toString(),
    selectionRange: { fromLine, toLine },
    selectionOffsets: { from, to },
    anchorTop,
  };
}
