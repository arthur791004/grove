// Grove's CodeMirror theme. Matches the existing Files-panel preview palette
// (which used prism's vsDark) and the terminal's ANSI scheme — same purple
// keywords, teal types, orange strings, yellow function names.

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const groveTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#010409',
      color: '#c9d1d9',
      height: '100%',
      fontSize: '12px',
    },
    '.cm-scroller': {
      fontFamily: 'var(--grove-mono)',
      lineHeight: '1.5',
    },
    '.cm-content': { caretColor: '#4d9ef6' },
    '.cm-gutters': {
      backgroundColor: '#010409',
      color: '#484f58',
      border: 'none',
    },
    '.cm-gutter.cm-lineNumbers .cm-gutterElement': {
      padding: '0 12px 0 8px',
      minWidth: '32px',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(255,255,255,0.03)',
      color: '#7d8590',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#4d9ef6' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      {
        backgroundColor: '#1e3a5f',
      },
    '.cm-line': { padding: '0 12px' },
    '.cm-target-line': {
      backgroundColor: 'rgba(77,158,246,0.10)',
      boxShadow: 'inset 2px 0 0 #4d9ef6',
      transition: 'background-color 350ms ease-out, box-shadow 350ms ease-out',
    },
    '.cm-target-line-fade': {
      backgroundColor: 'transparent',
      boxShadow: 'inset 2px 0 0 transparent',
    },
    '.cm-claude-edit': {
      backgroundColor: 'rgba(16,185,129,0.07)',
      boxShadow: 'inset 2px 0 0 #10B981',
    },
    '.cm-ai-added': {
      backgroundColor: 'rgba(63,185,80,0.16)',
      boxShadow: 'inset 2px 0 0 #3fb950',
    },
    '.cm-ai-removed': {
      backgroundColor: 'rgba(248,81,73,0.14)',
      boxShadow: 'inset 2px 0 0 #f85149',
      textDecoration: 'line-through',
      textDecorationColor: 'rgba(248,81,73,0.6)',
    },
    '.cm-panels': { backgroundColor: '#0d1117', color: '#c9d1d9' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid #21262d' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid #21262d' },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(255,210,80,0.18)',
      outline: '1px solid rgba(255,210,80,0.5)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(255,210,80,0.42)',
    },
    '.cm-tooltip': {
      backgroundColor: '#161b22',
      color: '#c9d1d9',
      border: '1px solid #30363d',
    },
  },
  { dark: true },
);

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: '#c586c0' },
  { tag: [t.string, t.special(t.string)], color: '#ce9178' },
  { tag: t.comment, color: '#6a737d', fontStyle: 'italic' },
  { tag: t.number, color: '#b5cea8' },
  { tag: [t.typeName, t.className], color: '#4ec9b0' },
  { tag: [t.variableName, t.propertyName], color: '#9cdcfe' },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: '#dcdcaa' },
  { tag: t.operator, color: '#d4d4d4' },
  { tag: t.punctuation, color: '#a3a3a3' },
  { tag: t.tagName, color: '#4ec9b0' },
  { tag: t.attributeName, color: '#9cdcfe' },
  { tag: t.bool, color: '#569cd6' },
  { tag: t.null, color: '#569cd6' },
  { tag: t.heading, color: '#569cd6', fontWeight: 'bold' },
  { tag: t.link, color: '#4d9ef6', textDecoration: 'underline' },
]);

export const groveHighlighting = syntaxHighlighting(highlightStyle);
