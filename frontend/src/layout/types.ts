// Obsidian-style layout tree. A leaf is a tabbed group of panes; a split is
// two children laid out horizontally ("h" = side-by-side, dragger is vertical)
// or vertically ("v" = stacked, dragger is horizontal). Panes are uniform —
// terminals, Claude sessions, diff/files/browser panels all share the Pane
// shape — so any pane can live in any leaf.
//
// During slice 1 the tree is *derived* from the legacy `tabs[]` +
// `activePanelId` state every render. From slice 3 it becomes the source of
// truth and the legacy fields go away.

export type PaneKind = 'shell' | 'claude' | 'diff' | 'files' | 'browser';

export interface Pane {
  // For terminal-backed panes this is the existing Tab id (so the same xterm
  // instance keeps mounting). For panel-backed panes ("diff" / "files" /
  // "browser") it's the panel registry id — there is only ever one of each
  // kind in the tree today, so the id can match the kind.
  id: string;
  kind: PaneKind;
  title: string;
}

export interface LeafNode {
  type: 'leaf';
  id: string;
  panes: Pane[];
  activePaneId: string | null;
}

export interface SplitNode {
  type: 'split';
  id: string;
  dir: 'h' | 'v';
  // Sizes of children in percent; sum is 100. Length matches children.
  sizes: number[];
  children: LayoutNode[];
  // 'tabs' marks the workspace's top-level container — its direct children
  // are user-facing "tabs", only one rendered at a time on the main screen.
  // Tree operations leave tabs containers alone even when they collapse to a
  // single child, so a sub-split underneath doesn't get demoted to root.
  // Sub-splits inside a tab have `role` omitted (or `'split'`).
  role?: 'tabs';
}

export type LayoutNode = LeafNode | SplitNode;

export function isLeaf(n: LayoutNode): n is LeafNode {
  return n.type === 'leaf';
}

export function isSplit(n: LayoutNode): n is SplitNode {
  return n.type === 'split';
}
