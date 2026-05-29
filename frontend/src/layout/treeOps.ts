// Pure functions for the per-workspace layout tree. The store imports these
// to mutate `layoutTreeByGroup` in response to actions. None of these touch
// the store; they take a tree in, return a new tree.

import type { LayoutNode, LeafNode, Pane, PaneKind, SplitNode } from './types';
import { isLeaf, isSplit } from './types';

const uid = () => Math.random().toString(36).slice(2, 10);

export function makeLeaf(panes: Pane[], activePaneId?: string | null): LeafNode {
  return {
    type: 'leaf',
    id: `leaf-${uid()}`,
    panes,
    activePaneId: activePaneId ?? (panes[0]?.id ?? null),
  };
}

export function findLeafContaining(node: LayoutNode, paneId: string): LeafNode | null {
  if (isLeaf(node)) return node.panes.some((p) => p.id === paneId) ? node : null;
  for (const child of node.children) {
    const found = findLeafContaining(child, paneId);
    if (found) return found;
  }
  return null;
}

export function findLeaf(node: LayoutNode, leafId: string): LeafNode | null {
  if (isLeaf(node)) return node.id === leafId ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, leafId);
    if (found) return found;
  }
  return null;
}

export function getAllPanes(node: LayoutNode): Pane[] {
  if (isLeaf(node)) return node.panes;
  return node.children.flatMap(getAllPanes);
}

export function getAllLeaves(node: LayoutNode): LeafNode[] {
  if (isLeaf(node)) return [node];
  return node.children.flatMap(getAllLeaves);
}

export function hasPaneOfKind(node: LayoutNode, kind: PaneKind): boolean {
  return getAllPanes(node).some((p) => p.kind === kind);
}

// Walk + transform every leaf. If `transform` returns null, the leaf is
// removed and its parent split collapses (one-child splits become the child).
export function mapLeaves(
  node: LayoutNode,
  transform: (leaf: LeafNode) => LeafNode | null,
): LayoutNode | null {
  if (isLeaf(node)) return transform(node);
  const mapped = node.children
    .map((c) => mapLeaves(c, transform))
    .filter((c): c is LayoutNode => c !== null);
  if (mapped.length === 0) return null;
  // Single-child splits normally collapse into their child, but a workspace
  // root's tabs container (`role: 'tabs'`) is intentionally a split with
  // potentially one child. Collapsing it would demote a sub-split into root
  // and turn the user's split layout into multiple top-level tabs.
  if (mapped.length === 1 && node.role !== 'tabs') return mapped[0];
  // Recompute sizes when count changes (evenly distribute the lost child's
  // share). When count is unchanged, keep the parent's sizes.
  const sizes =
    mapped.length === node.children.length
      ? node.sizes
      : mapped.length === 1
        ? [100]
        : Array(mapped.length).fill(100 / mapped.length);
  const next: SplitNode = { ...node, children: mapped, sizes };
  return next;
}

// Add a pane to a specific leaf (or the leaf containing some anchor pane).
// Activates the new pane.
export function addPaneToLeaf(
  node: LayoutNode,
  leafId: string,
  pane: Pane,
): LayoutNode {
  if (isLeaf(node)) {
    if (node.id !== leafId) return node;
    return { ...node, panes: [...node.panes, pane], activePaneId: pane.id };
  }
  return {
    ...node,
    children: node.children.map((c) => addPaneToLeaf(c, leafId, pane)),
  };
}

// Remove a pane by id; if its leaf empties, collapse via mapLeaves.
export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  return mapLeaves(node, (leaf) => {
    if (!leaf.panes.some((p) => p.id === paneId)) return leaf;
    const remaining = leaf.panes.filter((p) => p.id !== paneId);
    if (remaining.length === 0) return null;
    const stillActive =
      leaf.activePaneId && remaining.some((p) => p.id === leaf.activePaneId)
        ? leaf.activePaneId
        : remaining[0].id;
    return { ...leaf, panes: remaining, activePaneId: stillActive };
  });
}

// Set the active pane within the leaf that contains it.
export function setActivePane(node: LayoutNode, paneId: string): LayoutNode {
  if (isLeaf(node)) {
    return node.panes.some((p) => p.id === paneId)
      ? { ...node, activePaneId: paneId }
      : node;
  }
  return {
    ...node,
    children: node.children.map((c) => setActivePane(c, paneId)),
  };
}

// Add a horizontal split with `leaf` on the right of the existing tree. Used
// when opening a panel — keeps today's "panel on the right" feel as the
// default. Caller picks the percent.
export function splitRight(
  tree: LayoutNode,
  rightLeaf: LeafNode,
  rightPercent = 40,
): SplitNode {
  if (isSplit(tree) && tree.dir === 'h') {
    // Append to existing horizontal split, normalizing sizes.
    const newCount = tree.children.length + 1;
    const sizes = [
      ...tree.sizes.map((s) => s * (1 - rightPercent / 100)),
      rightPercent,
    ];
    return {
      ...tree,
      children: [...tree.children, rightLeaf],
      sizes: normalize(sizes, newCount),
    };
  }
  // Brand the new root as a tabs container so a later close that reduces it
  // to one child doesn't collapse it (which would demote a sub-split below
  // back into root and silently break a split layout).
  return {
    type: 'split',
    id: `tabs-${uid()}`,
    role: 'tabs',
    dir: 'h',
    sizes: [100 - rightPercent, rightPercent],
    children: [tree, rightLeaf],
  };
}

function normalize(sizes: number[], count: number): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum <= 0) return Array(count).fill(100 / count);
  return sizes.map((s) => (s / sum) * 100);
}

// Used by store actions during a "split-of-current" gesture (slice 4+).
export function splitLeaf(
  tree: LayoutNode,
  leafId: string,
  dir: 'h' | 'v',
  newLeaf: LeafNode,
  rightOrBelow: boolean,
): LayoutNode {
  if (isLeaf(tree)) {
    if (tree.id !== leafId) return tree;
    return {
      type: 'split',
      id: `split-${uid()}`,
      dir,
      sizes: [50, 50],
      children: rightOrBelow ? [tree, newLeaf] : [newLeaf, tree],
    };
  }
  return {
    ...tree,
    children: tree.children.map((c) => splitLeaf(c, leafId, dir, newLeaf, rightOrBelow)),
  };
}

// Reorder a leaf's panes. Used by the TabBar's dnd-kit sortable to commit
// the new ordering once the drop event fires.
export function reorderLeafPanes(
  tree: LayoutNode,
  leafId: string,
  paneIds: string[],
): LayoutNode {
  if (isLeaf(tree)) {
    if (tree.id !== leafId) return tree;
    const byId = new Map(tree.panes.map((p) => [p.id, p] as const));
    const next: Pane[] = [];
    for (const id of paneIds) {
      const p = byId.get(id);
      if (p) next.push(p);
    }
    // Append any panes the caller forgot to mention (shouldn't happen, but
    // safer than silently dropping them).
    for (const p of tree.panes) if (!paneIds.includes(p.id)) next.push(p);
    return { ...tree, panes: next };
  }
  return {
    ...tree,
    children: tree.children.map((c) => reorderLeafPanes(c, leafId, paneIds)),
  };
}

export function updateSplitSizes(
  tree: LayoutNode,
  splitId: string,
  sizes: number[],
): LayoutNode {
  if (isLeaf(tree)) return tree;
  if (tree.id === splitId) return { ...tree, sizes };
  return {
    ...tree,
    children: tree.children.map((c) => updateSplitSizes(c, splitId, sizes)),
  };
}
