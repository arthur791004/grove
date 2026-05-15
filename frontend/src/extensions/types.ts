import type { ComponentType, ReactNode } from 'react';

// Props every right-panel component receives from the host. Panels can ignore
// fields they don't care about (DiffPanel doesn't use `panelWidth`).
export interface PanelProps {
  forcedFullscreen: boolean;
  panelWidth: number;
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
