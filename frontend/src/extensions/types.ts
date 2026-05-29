import type { ComponentType, ReactNode } from 'react';

// Props every right-panel component receives from the host. Panels can ignore
// fields they don't care about (DiffPanel doesn't use `panelWidth`).
export interface PanelProps {
  forcedFullscreen: boolean;
  panelWidth: number;
  // Unique id of the pane this component instance is rendering. Lets panels
  // key per-pane state (selected file, search query, URL, …) by paneId so
  // multiple Diff / Files / Browser panes in the same workspace don't share
  // state.
  paneId: string;
}

export interface PanelDefinition {
  id: string;
  title: string;
  // Rendered in the titlebar toggle button. ReactNode (not ComponentType) so
  // both `<Foo />` JSX and plain SVG nodes work — most built-ins pass an SVG.
  icon: ReactNode;
  component: ComponentType<PanelProps>;
  // `builtin` panels are first-party and cannot be removed; `extension`
  // panels come from `~/.grove/extensions/`.
  source: 'builtin' | 'extension';
}
