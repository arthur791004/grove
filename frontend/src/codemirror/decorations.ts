// Editor decorations layered over file content.
//
// targetLineField:    blue stripe + tinted bg on the clicked line, fades to
//                     transparent ~2s after the click via a CSS transition on
//                     the `cm-target-line-fade` modifier class.
// claudeEditField:    green stripe + tinted bg on lines Claude touched.
//                     Persists until the next openFile() clears it.

import { StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

export const setTargetLine = StateEffect.define<{ line: number; fade: boolean } | null>();

export const targetLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setTargetLine)) continue;
      if (e.value === null) {
        next = Decoration.none;
        continue;
      }
      const docLines = tr.state.doc.lines;
      if (e.value.line < 1 || e.value.line > docLines) {
        next = Decoration.none;
        continue;
      }
      const line = tr.state.doc.line(e.value.line);
      const cls = e.value.fade ? 'cm-target-line cm-target-line-fade' : 'cm-target-line';
      next = Decoration.set([Decoration.line({ class: cls }).range(line.from)]);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const setClaudeEdit = StateEffect.define<{ fromLine: number; toLine: number } | null>();

export const claudeEditField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setClaudeEdit)) continue;
      if (e.value === null) {
        next = Decoration.none;
        continue;
      }
      const docLines = tr.state.doc.lines;
      const fromLine = Math.max(1, Math.min(e.value.fromLine, docLines));
      const toLine = Math.max(fromLine, Math.min(e.value.toLine, docLines));
      const marks: Range<Decoration>[] = [];
      for (let n = fromLine; n <= toLine; n++) {
        const line = tr.state.doc.line(n);
        marks.push(Decoration.line({ class: 'cm-claude-edit' }).range(line.from));
      }
      next = Decoration.set(marks);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});
