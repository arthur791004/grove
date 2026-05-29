import { useEffect } from 'react';
import { useStore, makePanelPane } from './store';
import { executePin } from './PinBar';
import type { LayoutNode, LeafNode, PaneKind } from './layout/types';

// Find the leaf containing the given pane id anywhere in the tree.
function findLeafContaining(tree: LayoutNode, paneId: string): LeafNode | null {
  if (tree.type === 'leaf') {
    return tree.panes.some((p) => p.id === paneId) ? tree : null;
  }
  for (const c of tree.children) {
    const r = findLeafContaining(c, paneId);
    if (r) return r;
  }
  return null;
}

// Get the workspace + tree + currently-focused leaf for shortcut handlers
// that need to act in the active scope.
function focusedContext() {
  const s = useStore.getState();
  const focusedPaneId = s.activePanelId ?? s.activeTabId;
  if (!focusedPaneId) return null;
  const tab = s.tabs.find((t) => t.id === focusedPaneId);
  const gid =
    tab?.groupId ??
    (function findGroup(): string | undefined {
      for (const [g, t] of Object.entries(s.layoutTreeByGroup)) {
        if (findLeafContaining(t, focusedPaneId)) return g;
      }
      return undefined;
    })();
  if (!gid) return null;
  const tree = s.layoutTreeByGroup[gid];
  if (!tree) return null;
  const leaf = findLeafContaining(tree, focusedPaneId);
  if (!leaf) return null;
  const pane = leaf.panes.find((p) => p.id === focusedPaneId) ?? leaf.panes[0];
  if (!pane) return null;
  return { state: s, groupId: gid, tree, leaf, pane };
}

// Top-level tab list = root.children if root is a split, else [root].
function topLevelTabs(tree: LayoutNode): LayoutNode[] {
  return tree.type === 'split' ? tree.children : [tree];
}

// First focusable pane id within a node — prefers the node's active pane,
// otherwise its first leaf's first pane.
function focusableIdIn(node: LayoutNode): string | null {
  if (node.type === 'leaf') return node.activePaneId ?? node.panes[0]?.id ?? null;
  for (const c of node.children) {
    const r = focusableIdIn(c);
    if (r) return r;
  }
  return null;
}

// Focus a pane id — drives both `activeTabId` (for terminal/shell panes) and
// `activePanelId` (for panel kinds), and updates the containing leaf's
// active so the layout renders correctly.
function focusPane(groupId: string, paneId: string, kind: PaneKind | undefined) {
  const s = useStore.getState();
  s.setActivePaneInTree(groupId, paneId);
  if (kind === 'shell' || kind === 'claude') {
    s.setActiveTab(paneId);
  } else {
    useStore.setState({ activePanelId: paneId });
  }
}

export function useShortcuts(openPalette: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const alt = e.altKey;
      const shift = e.shiftKey;

      // ⌘T — new tab inside the focused leaf (matches `+` in TabBar).
      if (e.key === 't' && !shift && !alt) {
        e.preventDefault();
        const ctx = focusedContext();
        const inLeafId = ctx?.leaf.id;
        useStore
          .getState()
          .newTab(undefined, undefined, inLeafId ? { inLeafId } : undefined);
        return;
      }

      // ⌘W — close the focused pane (collapses the tab when its last pane
      // closes).
      if (e.key === 'w' && !shift && !alt) {
        e.preventDefault();
        const ctx = focusedContext();
        if (!ctx) return;
        if (ctx.pane.kind === 'shell' || ctx.pane.kind === 'claude') {
          useStore.getState().closeTab(ctx.pane.id);
        } else {
          useStore.getState().removePaneFromTree(ctx.groupId, ctx.pane.id);
        }
        return;
      }

      // ⌘D / ⌘⇧D — split the focused leaf right / down with another pane of
      // the same kind. Terminal kinds get a new shell/claude tab in a fresh
      // sibling leaf; panel kinds get a freshly-instanced panel pane.
      if (e.key === 'd' && !alt) {
        e.preventDefault();
        const ctx = focusedContext();
        if (!ctx) return;
        const dir: 'h' | 'v' = shift ? 'v' : 'h';
        if (ctx.pane.kind === 'shell' || ctx.pane.kind === 'claude') {
          useStore
            .getState()
            .splitLeafWithNewTab(ctx.groupId, ctx.leaf.id, dir, ctx.pane.kind);
        } else if (
          ctx.pane.kind === 'diff' ||
          ctx.pane.kind === 'files' ||
          ctx.pane.kind === 'browser'
        ) {
          const { pane, state } = makePanelPane(ctx.pane.kind);
          useStore.getState().splitLeafInTree(ctx.groupId, ctx.leaf.id, dir, pane, true);
          useStore.setState((prev) => ({
            activePanelId: pane.id,
            paneState: { ...prev.paneState, [pane.id]: state },
          }));
        }
        return;
      }

      // ⌘P / ⌘K — command palette (palette opens the same fuzzy search).
      if ((e.key === 'p' || e.key === 'k') && !shift && !alt) {
        e.preventDefault();
        openPalette();
        return;
      }

      // ⌘\ — toggle sidebar.
      if (e.key === '\\' && !alt) {
        e.preventDefault();
        useStore.getState().toggleSidebar();
        return;
      }

      // ⌘1..9 — jump to top-level tab N in the active workspace. Falls back
      // to the active-workspace's first tree top-level if no focused pane.
      if (/^[1-9]$/.test(e.key) && !shift && !alt) {
        e.preventDefault();
        const ctx = focusedContext();
        if (!ctx) return;
        const tops = topLevelTabs(ctx.tree);
        const target = tops[parseInt(e.key, 10) - 1];
        if (!target) return;
        const paneId = focusableIdIn(target);
        if (paneId) {
          const targetPane = (function find(n: LayoutNode): LeafNode['panes'][number] | null {
            if (n.type === 'leaf')
              return n.panes.find((p) => p.id === paneId) ?? null;
            for (const c of n.children) {
              const r = find(c);
              if (r) return r;
            }
            return null;
          })(target);
          focusPane(ctx.groupId, paneId, targetPane?.kind);
        }
        return;
      }

      // ⌘⇧1..9 — fire pin N (e.code because Shift mutates printable digits).
      if (shift && !alt && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        const s = useStore.getState();
        const activeGroupId = s.tabs.find((t) => t.id === s.activeTabId)?.groupId ?? null;
        const ordered = [
          ...s.pins.filter((p) => p.scope === 'global' && !p.hidden),
          ...s.pins.filter(
            (p) => p.scope === 'workspace' && p.groupId === activeGroupId && !p.hidden,
          ),
        ];
        const pin = ordered[Number(e.code.slice(5)) - 1];
        if (pin) executePin(pin);
        return;
      }

      // ⌘⇧[ / ⌘⇧] — cycle top-level tabs in the active workspace.
      const isPrev = shift && (e.key === '[' || e.key === '{');
      const isNext = shift && (e.key === ']' || e.key === '}');
      if (isPrev || isNext) {
        e.preventDefault();
        const ctx = focusedContext();
        if (!ctx) return;
        const tops = topLevelTabs(ctx.tree);
        if (tops.length <= 1) return;
        const currentTop = tops.findIndex((n) =>
          (function contains(node: LayoutNode): boolean {
            if (node.type === 'leaf') return node.panes.some((p) => p.id === ctx.pane.id);
            return node.children.some(contains);
          })(n),
        );
        const dir = isNext ? 1 : -1;
        const next = tops[(currentTop + dir + tops.length) % tops.length];
        const paneId = focusableIdIn(next);
        if (paneId) {
          const targetPane = (function find(n: LayoutNode): LeafNode['panes'][number] | null {
            if (n.type === 'leaf')
              return n.panes.find((p) => p.id === paneId) ?? null;
            for (const c of n.children) {
              const r = find(c);
              if (r) return r;
            }
            return null;
          })(next);
          focusPane(ctx.groupId, paneId, targetPane?.kind);
        }
        return;
      }

      // ⌘⌥↑/↓/←/→ — focus the sibling leaf in that direction within the
      // active sub-split. Walks ancestors until it finds a split whose `dir`
      // matches the requested axis, then picks the neighbouring child.
      if (
        alt &&
        (e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        const dir =
          e.key === 'ArrowUp'
            ? 'up'
            : e.key === 'ArrowDown'
              ? 'down'
              : e.key === 'ArrowLeft'
                ? 'left'
                : 'right';
        focusInDirection(dir);
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);
}

// Focus the neighbouring leaf in the requested direction. Walks ancestors
// until it finds a split whose direction matches the requested axis, then
// picks the previous or next sibling child.
function focusInDirection(dir: 'up' | 'down' | 'left' | 'right') {
  const ctx = focusedContext();
  if (!ctx) return;
  const axis: 'h' | 'v' = dir === 'left' || dir === 'right' ? 'h' : 'v';
  const wantPrev = dir === 'left' || dir === 'up';
  // Build the path from root to the focused leaf.
  const path: LayoutNode[] = [];
  (function build(n: LayoutNode): boolean {
    path.push(n);
    if (n.type === 'leaf') return n.id === ctx.leaf.id;
    for (const c of n.children) {
      if (build(c)) return true;
    }
    path.pop();
    return false;
  })(ctx.tree);
  if (path.length === 0) return;
  // Walk up looking for a split with matching axis and a sibling in the
  // requested direction.
  for (let i = path.length - 2; i >= 0; i--) {
    const node = path[i];
    if (node.type !== 'split' || node.dir !== axis) continue;
    const child = path[i + 1];
    const idx = node.children.indexOf(child);
    const siblingIdx = wantPrev ? idx - 1 : idx + 1;
    const sibling = node.children[siblingIdx];
    if (!sibling) continue;
    const paneId = focusableIdIn(sibling);
    if (paneId) {
      const targetPane = (function find(n: LayoutNode): LeafNode['panes'][number] | null {
        if (n.type === 'leaf') return n.panes.find((p) => p.id === paneId) ?? null;
        for (const c of n.children) {
          const r = find(c);
          if (r) return r;
        }
        return null;
      })(sibling);
      focusPane(ctx.groupId, paneId, targetPane?.kind);
    }
    return;
  }
}
