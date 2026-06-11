import { lazy } from 'react';
import { panelRegistry } from './registry';
import { registerActionHandler } from './actions';
import { useStore } from '../store';

// Built-in action wiring. These bind once at module load (App.tsx imports
// this file for side effects) so terminal click-handlers can fire even when
// the relevant panel isn't currently mounted — opening the panel + handing
// it the payload happens here.
registerActionHandler('open-url', (payload) => {
  const p = payload as { url?: unknown };
  if (typeof p?.url !== 'string') return;
  const s = useStore.getState();
  s.setBrowserPanelUrl(p.url);
  s.openPanel('browser');
});

registerActionHandler('open-file', (payload) => {
  const p = payload as {
    path?: unknown;
    kind?: unknown;
    line?: unknown;
    col?: unknown;
    claudeEditRange?: unknown;
  };
  if (typeof p?.path !== 'string') return;
  const kind = p.kind === 'dir' ? 'dir' : 'file';
  const line = typeof p.line === 'number' && p.line >= 1 ? p.line : undefined;
  const col = typeof p.col === 'number' && p.col >= 1 ? p.col : undefined;
  let claudeEditRange: { fromLine: number; toLine: number } | undefined;
  if (p.claudeEditRange && typeof p.claudeEditRange === 'object') {
    const r = p.claudeEditRange as { fromLine?: unknown; toLine?: unknown };
    if (typeof r.fromLine === 'number' && typeof r.toLine === 'number') {
      claudeEditRange = { fromLine: r.fromLine, toLine: r.toLine };
    }
  }
  useStore.getState().openFileInBrowser(p.path, kind, { line, col, claudeEditRange });
});

// Code-split the three built-in panels — each pulls a non-trivial dep tree
// (react-diff-view for Diff, prism + icon set for Files, the embedded
// browser view bindings for Browser). Their bundles only land when the
// active panel switches to that id.
const DiffPanel = lazy(() => import('../DiffPanel').then((m) => ({ default: m.DiffPanel })));
const FileBrowserPanel = lazy(() =>
  import('../FileBrowserPanel').then((m) => ({ default: m.FileBrowserPanel })),
);
const BrowserPanel = lazy(() =>
  import('../BrowserPanel').then((m) => ({ default: m.BrowserPanel })),
);

// Registration order = display order in the titlebar (rightmost cluster).
// Matches the historical layout: Browser, Files, Diff (left → right).
panelRegistry.register({
  id: 'browser',
  title: 'Browser',
  source: 'builtin',
  component: BrowserPanel,
  icon: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" strokeLinecap="round" />
    </svg>
  ),
});

panelRegistry.register({
  id: 'files',
  title: 'Files',
  source: 'builtin',
  component: FileBrowserPanel,
  icon: (
    <svg width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor">
      <path
        d="M2 3.5a1 1 0 0 1 1-1h4l1.5 1.5h7a1 1 0 0 1 1 1V12.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5z"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  ),
});

panelRegistry.register({
  id: 'diff',
  title: 'Diff',
  source: 'builtin',
  component: DiffPanel,
  icon: (
    <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor">
      <path
        d="M3 1h5l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M8 1v3h3" strokeWidth="1.2" />
      <path d="M5 7.5h4M7 5.5v4" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5 11h4" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
});
