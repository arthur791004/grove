import { describe, expect, it } from 'vitest';
import {
  addPaneToLeaf,
  findLeaf,
  findLeafContaining,
  getAllLeaves,
  getAllPanes,
  hasPaneOfKind,
  makeLeaf,
  mapLeaves,
  removePane,
  reorderLeafPanes,
  setActivePane,
  splitLeaf,
  splitRight,
  updateSplitSizes,
} from './treeOps';
import type { LayoutNode, LeafNode, Pane, SplitNode } from './types';
import { isLeaf, isSplit } from './types';

function pane(id: string, kind: Pane['kind'] = 'shell'): Pane {
  return { id, kind, title: id };
}

// Deterministic leaf builder — makeLeaf randomizes ids, so when a test needs
// to reference a leaf by id we set it explicitly.
function leaf(id: string, panes: Pane[], activePaneId?: string | null): LeafNode {
  return { type: 'leaf', id, panes, activePaneId: activePaneId ?? panes[0]?.id ?? null };
}

function split(
  id: string,
  children: LayoutNode[],
  opts: { dir?: 'h' | 'v'; sizes?: number[]; role?: 'tabs' } = {},
): SplitNode {
  return {
    type: 'split',
    id,
    dir: opts.dir ?? 'h',
    sizes: opts.sizes ?? children.map(() => 100 / children.length),
    children,
    ...(opts.role ? { role: opts.role } : {}),
  };
}

describe('makeLeaf', () => {
  it('defaults activePaneId to the first pane', () => {
    const l = makeLeaf([pane('a'), pane('b')]);
    expect(l.type).toBe('leaf');
    expect(l.activePaneId).toBe('a');
    expect(l.id).toMatch(/^leaf-/);
  });

  it('honors an explicit activePaneId', () => {
    expect(makeLeaf([pane('a'), pane('b')], 'b').activePaneId).toBe('b');
  });

  it('yields null activePaneId for an empty leaf', () => {
    expect(makeLeaf([]).activePaneId).toBeNull();
  });

  it('gives each leaf a unique id', () => {
    const ids = new Set(Array.from({ length: 100 }, () => makeLeaf([]).id));
    expect(ids.size).toBe(100);
  });
});

describe('findLeafContaining / findLeaf', () => {
  const tree = split('root', [leaf('L1', [pane('a'), pane('b')]), leaf('L2', [pane('c')])]);

  it('finds the leaf holding a pane', () => {
    expect(findLeafContaining(tree, 'b')?.id).toBe('L1');
    expect(findLeafContaining(tree, 'c')?.id).toBe('L2');
  });

  it('returns null for an unknown pane', () => {
    expect(findLeafContaining(tree, 'zzz')).toBeNull();
  });

  it('finds a leaf by id', () => {
    expect(findLeaf(tree, 'L2')?.panes[0].id).toBe('c');
    expect(findLeaf(tree, 'nope')).toBeNull();
  });

  it('works when the root itself is a bare leaf', () => {
    const root = leaf('only', [pane('x')]);
    expect(findLeafContaining(root, 'x')?.id).toBe('only');
    expect(findLeaf(root, 'only')?.id).toBe('only');
  });
});

describe('getAllPanes / getAllLeaves / hasPaneOfKind', () => {
  const tree = split('root', [
    leaf('L1', [pane('a'), pane('b', 'claude')]),
    split('sub', [leaf('L2', [pane('c', 'files')]), leaf('L3', [pane('d')])]),
  ]);

  it('flattens panes in order', () => {
    expect(getAllPanes(tree).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('flattens leaves in order', () => {
    expect(getAllLeaves(tree).map((l) => l.id)).toEqual(['L1', 'L2', 'L3']);
  });

  it('detects pane kinds present and absent', () => {
    expect(hasPaneOfKind(tree, 'claude')).toBe(true);
    expect(hasPaneOfKind(tree, 'files')).toBe(true);
    expect(hasPaneOfKind(tree, 'browser')).toBe(false);
  });
});

describe('mapLeaves', () => {
  it('collapses a single-child split into its child', () => {
    const tree = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')])]);
    const next = mapLeaves(tree, (l) => (l.id === 'L2' ? null : l));
    expect(next).not.toBeNull();
    expect(isLeaf(next!)).toBe(true);
    expect((next as LeafNode).id).toBe('L1');
  });

  it("never collapses a role:'tabs' container, even at one child", () => {
    const tree = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')])], {
      role: 'tabs',
    });
    const next = mapLeaves(tree, (l) => (l.id === 'L2' ? null : l));
    expect(isSplit(next!)).toBe(true);
    expect((next as SplitNode).role).toBe('tabs');
    expect((next as SplitNode).children).toHaveLength(1);
    expect((next as SplitNode).sizes).toEqual([100]);
  });

  it('returns null when every leaf is removed', () => {
    const tree = split('root', [leaf('L1', [pane('a')])], { role: 'tabs' });
    expect(mapLeaves(tree, () => null)).toBeNull();
  });

  it('redistributes sizes evenly when a child is dropped', () => {
    const tree = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')]), leaf('L3', [pane('c')])], {
      sizes: [50, 30, 20],
    });
    const next = mapLeaves(tree, (l) => (l.id === 'L3' ? null : l)) as SplitNode;
    expect(next.children).toHaveLength(2);
    expect(next.sizes).toEqual([50, 50]);
  });

  it('preserves sizes when no child count change', () => {
    const tree = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')])], {
      sizes: [70, 30],
    });
    const next = mapLeaves(tree, (l) => l) as SplitNode;
    expect(next.sizes).toEqual([70, 30]);
  });
});

describe('addPaneToLeaf', () => {
  it('appends to the target leaf and activates the new pane', () => {
    const tree = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')])]);
    const next = addPaneToLeaf(tree, 'L2', pane('c')) as SplitNode;
    const l2 = findLeaf(next, 'L2')!;
    expect(l2.panes.map((p) => p.id)).toEqual(['b', 'c']);
    expect(l2.activePaneId).toBe('c');
  });

  it('leaves other leaves untouched', () => {
    const tree = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')])]);
    const next = addPaneToLeaf(tree, 'L2', pane('c')) as SplitNode;
    expect(findLeaf(next, 'L1')!.panes.map((p) => p.id)).toEqual(['a']);
  });
});

describe('removePane', () => {
  it('removes a pane from a multi-pane leaf, keeping the leaf', () => {
    const tree = leaf('L1', [pane('a'), pane('b')], 'a');
    const next = removePane(tree, 'a') as LeafNode;
    expect(next.panes.map((p) => p.id)).toEqual(['b']);
    expect(next.activePaneId).toBe('b');
  });

  it('keeps the existing active pane when a different one is removed', () => {
    const tree = leaf('L1', [pane('a'), pane('b'), pane('c')], 'c');
    const next = removePane(tree, 'a') as LeafNode;
    expect(next.activePaneId).toBe('c');
  });

  it('collapses an emptied leaf and its parent split', () => {
    const tree = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')])]);
    const next = removePane(tree, 'a');
    expect(isLeaf(next!)).toBe(true);
    expect((next as LeafNode).id).toBe('L2');
  });

  it('returns null when removing the only pane of the only leaf', () => {
    expect(removePane(leaf('L1', [pane('a')]), 'a')).toBeNull();
  });

  it('is a no-op for an unknown pane id', () => {
    const tree = leaf('L1', [pane('a'), pane('b')]);
    const next = removePane(tree, 'zzz') as LeafNode;
    expect(next.panes.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('setActivePane', () => {
  it('activates a pane in the leaf that holds it', () => {
    const tree = split('root', [leaf('L1', [pane('a'), pane('b')], 'a'), leaf('L2', [pane('c')])]);
    const next = setActivePane(tree, 'b') as SplitNode;
    expect(findLeaf(next, 'L1')!.activePaneId).toBe('b');
  });

  it('does not change leaves that lack the pane', () => {
    const tree = split('root', [leaf('L1', [pane('a')], 'a'), leaf('L2', [pane('c')], 'c')]);
    const next = setActivePane(tree, 'a') as SplitNode;
    expect(findLeaf(next, 'L2')!.activePaneId).toBe('c');
  });
});

describe('splitRight', () => {
  it('wraps a bare leaf in a tabs-branded split', () => {
    const result = splitRight(leaf('L1', [pane('a')]), makeLeaf([pane('b')]), 40);
    expect(result.type).toBe('split');
    expect(result.role).toBe('tabs');
    expect(result.dir).toBe('h');
    expect(result.children).toHaveLength(2);
    expect(result.sizes).toEqual([60, 40]);
  });

  it('appends to an existing horizontal split and renormalizes to 100', () => {
    const base = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')])], {
      dir: 'h',
      sizes: [50, 50],
    });
    const result = splitRight(base, makeLeaf([pane('c')]), 50);
    expect(result.id).toBe('root');
    expect(result.children).toHaveLength(3);
    expect(Math.round(result.sizes.reduce((a, b) => a + b, 0))).toBe(100);
  });

  it('wraps (does not append) when the existing split is vertical', () => {
    const base = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')])], { dir: 'v' });
    const result = splitRight(base, makeLeaf([pane('c')]), 40);
    expect(result.role).toBe('tabs');
    expect(result.children).toHaveLength(2);
    // The original vertical split is nested as the left child.
    expect(result.children[0]).toBe(base);
  });
});

describe('splitLeaf', () => {
  it('splits a leaf into a 50/50 split, new leaf on the right/below', () => {
    const result = splitLeaf(leaf('L1', [pane('a')]), 'L1', 'v', makeLeaf([pane('b')]), true);
    expect(isSplit(result)).toBe(true);
    const s = result as SplitNode;
    expect(s.dir).toBe('v');
    expect(s.sizes).toEqual([50, 50]);
    expect((s.children[0] as LeafNode).id).toBe('L1');
  });

  it('places the new leaf first when rightOrBelow is false', () => {
    const newLeaf = makeLeaf([pane('b')]);
    const result = splitLeaf(leaf('L1', [pane('a')]), 'L1', 'h', newLeaf, false) as SplitNode;
    expect(result.children[0]).toBe(newLeaf);
    expect((result.children[1] as LeafNode).id).toBe('L1');
  });

  it('recurses into nested splits and leaves non-targets untouched', () => {
    const tree = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')])]);
    const result = splitLeaf(tree, 'L2', 'h', makeLeaf([pane('c')]), true) as SplitNode;
    expect((result.children[0] as LeafNode).id).toBe('L1');
    expect(isSplit(result.children[1])).toBe(true);
  });

  it('is a no-op when the leaf id is not found', () => {
    const tree = leaf('L1', [pane('a')]);
    expect(splitLeaf(tree, 'nope', 'h', makeLeaf([pane('b')]), true)).toBe(tree);
  });
});

describe('reorderLeafPanes', () => {
  it('reorders panes to match the given id order', () => {
    const tree = leaf('L1', [pane('a'), pane('b'), pane('c')]);
    const next = reorderLeafPanes(tree, 'L1', ['c', 'a', 'b']) as LeafNode;
    expect(next.panes.map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends panes omitted from the id list rather than dropping them', () => {
    const tree = leaf('L1', [pane('a'), pane('b'), pane('c')]);
    const next = reorderLeafPanes(tree, 'L1', ['c']) as LeafNode;
    expect(next.panes.map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('ignores ids that do not exist in the leaf', () => {
    const tree = leaf('L1', [pane('a'), pane('b')]);
    const next = reorderLeafPanes(tree, 'L1', ['b', 'ghost', 'a']) as LeafNode;
    expect(next.panes.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('only touches the target leaf', () => {
    const tree = split('root', [leaf('L1', [pane('a'), pane('b')]), leaf('L2', [pane('c'), pane('d')])]);
    const next = reorderLeafPanes(tree, 'L1', ['b', 'a']) as SplitNode;
    expect(findLeaf(next, 'L1')!.panes.map((p) => p.id)).toEqual(['b', 'a']);
    expect(findLeaf(next, 'L2')!.panes.map((p) => p.id)).toEqual(['c', 'd']);
  });
});

describe('updateSplitSizes', () => {
  it('updates the matching split sizes', () => {
    const tree = split('root', [leaf('L1', [pane('a')]), leaf('L2', [pane('b')])], { sizes: [50, 50] });
    const next = updateSplitSizes(tree, 'root', [70, 30]) as SplitNode;
    expect(next.sizes).toEqual([70, 30]);
  });

  it('recurses into nested splits', () => {
    const inner = split('inner', [leaf('L2', [pane('b')]), leaf('L3', [pane('c')])], { sizes: [50, 50] });
    const tree = split('root', [leaf('L1', [pane('a')]), inner]);
    const next = updateSplitSizes(tree, 'inner', [20, 80]) as SplitNode;
    expect((next.children[1] as SplitNode).sizes).toEqual([20, 80]);
  });

  it('is a no-op on a bare leaf', () => {
    const tree = leaf('L1', [pane('a')]);
    expect(updateSplitSizes(tree, 'whatever', [1])).toBe(tree);
  });
});

describe('cross-leaf move composition (the regression behind the vanish bug)', () => {
  // Mirrors store.moveTab's cross-group path: removePane from source, then
  // land the pane as a new top-level leaf in the target via splitRight.
  it('relocates a pane without losing it or orphaning the source', () => {
    const source = split('src', [leaf('L1', [pane('a'), pane('keep')]), leaf('L2', [pane('b')])], {
      role: 'tabs',
    });
    const target: LayoutNode = leaf('T1', [pane('x')]);

    const moved = getAllPanes(source).find((p) => p.id === 'b')!;
    const trimmed = removePane(source, 'b') ?? makeLeaf([]);
    const nextTarget = splitRight(target, makeLeaf([moved]), 50);

    // Pane is gone from the source...
    expect(getAllPanes(trimmed).map((p) => p.id)).toEqual(['a', 'keep']);
    // ...and present exactly once in the target.
    expect(getAllPanes(nextTarget).map((p) => p.id)).toEqual(['x', 'b']);
  });
});
