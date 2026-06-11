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
import { setTargetLine, targetLineField, setClaudeEdit, claudeEditField } from './decorations';
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
}

export interface CodeMirrorHandle {
  openFile(opts: OpenFileOptions): void;
  clear(): void;
  promptGotoLine(): void;
  openSearch(): void;
}

interface Props {
  onCursorChange?: (pos: CursorPosition) => void;
  onLanguageChange?: (label: string) => void;
}

// Try-import these in case CM6 doesn't expose `commands` in older minor
// versions of the host's transitive deps. We pulled it in via the umbrella
// `codemirror` package so the import above is the canonical path.

const LARGE_FILE_LINES = 5_000;

export const CodeMirrorEditor = forwardRef<CodeMirrorHandle, Props>(function CodeMirrorEditor(
  { onCursorChange, onLanguageChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartmentRef = useRef<Compartment>(new Compartment());
  const cursorListenerRef = useRef<((p: CursorPosition) => void) | undefined>(onCursorChange);
  const langListenerRef = useRef<((s: string) => void) | undefined>(onLanguageChange);
  cursorListenerRef.current = onCursorChange;
  langListenerRef.current = onLanguageChange;

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
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      groveTheme,
      groveHighlighting,
      targetLineField,
      claudeEditField,
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
      }),
    ];
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

        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: opts.content },
          effects: [
            langCompartmentRef.current.reconfigure(langExtension),
            setTargetLine.of(null),
            setClaudeEdit.of(null),
          ],
          // Reset selection to top so the cursor doesn't dangle past the new
          // doc's end if it was further than the new length.
          selection: { anchor: 0 },
        });

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
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: '' },
          effects: [
            langCompartmentRef.current.reconfigure([]),
            setTargetLine.of(null),
            setClaudeEdit.of(null),
          ],
        });
        langListenerRef.current?.('Plain Text');
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
