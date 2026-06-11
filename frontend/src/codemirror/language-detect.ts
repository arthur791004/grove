// Maps file extension to a CodeMirror language extension. Returns an empty
// array for unknown types so the editor falls back to plain text without
// throwing. Mirrors `codeLanguage.ts` (the prism mapping) but for CM6.

import type { Extension } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';

export interface LanguageInfo {
  extension: Extension;
  label: string;
}

const EMPTY: LanguageInfo = { extension: [], label: 'Plain Text' };

export function detectCmLanguage(path: string | null): LanguageInfo {
  if (!path) return EMPTY;
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (base === 'dockerfile' || base.endsWith('.dockerfile')) {
    return { extension: StreamLanguage.define(dockerFile), label: 'Dockerfile' };
  }
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  switch (ext) {
    case 'ts':
      return { extension: javascript({ typescript: true }), label: 'TypeScript' };
    case 'tsx':
      return { extension: javascript({ typescript: true, jsx: true }), label: 'TSX' };
    case 'js':
    case 'mjs':
    case 'cjs':
      return { extension: javascript(), label: 'JavaScript' };
    case 'jsx':
      return { extension: javascript({ jsx: true }), label: 'JSX' };
    case 'css':
    case 'scss':
    case 'sass':
      return { extension: css(), label: ext.toUpperCase() };
    case 'json':
      return { extension: json(), label: 'JSON' };
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
      return { extension: html(), label: 'HTML' };
    case 'md':
    case 'mdx':
    case 'markdown':
      return { extension: markdown(), label: 'Markdown' };
    case 'sh':
    case 'bash':
    case 'zsh':
      return { extension: StreamLanguage.define(shell), label: 'Shell' };
    case 'yml':
    case 'yaml':
      return { extension: StreamLanguage.define(yaml), label: 'YAML' };
    case 'toml':
      return { extension: StreamLanguage.define(toml), label: 'TOML' };
    case 'sql':
      return { extension: StreamLanguage.define(standardSQL), label: 'SQL' };
    default:
      return EMPTY;
  }
}
