// Walks a LayoutNode tree and renders it. Splits use react-resizable-panels
// v4 (Group / Panel / Separator) for a draggable divider; leaves render the
// existing Workspace component (for the workspace's tabs) or a panel registry
// component (for diff / files / browser). Slice 1+2 only needs to handle two
// shapes — single leaf, and a horizontal split with one workspace leaf + one
// panel leaf — but the walker is generic so slices 4-5 can add splits without
// changing this file.

import { Suspense, useCallback, useState } from 'react';
import { Box, Flex, Text } from '@chakra-ui/react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { FileDiff, FolderTree, Globe, Sparkles, Terminal } from 'lucide-react';
import { findLeafContaining, getAllPanes } from './treeOps';
import { useHideBrowserOverlay } from '../useHideBrowserOverlay';
import type { PaneKind } from './types';
import { SquareLoader } from '../SquareLoader';
import { useStore } from '../store';
import { usePanels } from '../extensions/registry';
import { PaneOverlay } from './PaneOverlay';
import { LeafTabBar } from './LeafTabBar';
import { LeafTerminalHost } from './LeafTerminalHost';
import type { LayoutNode, LeafNode, Pane } from './types';
import { isLeaf } from './types';
import { WorkspaceVisibilityProvider } from './visibility';

interface LayoutHostProps {
  tree: LayoutNode;
  // Persist split size changes back to the caller (today: panel width %).
  onSplitResize?: (splitId: string, sizes: number[]) => void;
  // True when a panel pane should be allowed to draw its own "fullscreen"
  // affordance — passed through to panel components for parity with today.
  forcedFullscreen: boolean;
  // Pixel width passed to panel components; matches today's
  // `panelWidth` prop contract.
  panelWidth: number;
  // Group id whose tree is being rendered — leaves use it to call the
  // tree-mutation actions (close, split).
  groupId: string;
  // False when this workspace's LayoutHost is mounted but hidden via
  // display:none (other workspace is in front). Descendants — chiefly
  // TerminalView and BrowserPanel — read this through
  // useWorkspaceVisible() so they can refit / re-attach when the
  // workspace flips back to visible.
  visible?: boolean;
}

// Threaded through the layout tree so a leaf can dim itself when it's the
// active swap-drag source.
interface NodeContext {
  activeSwapLeafId: string | null;
}

export function LayoutHost(props: LayoutHostProps) {
  // Single global DndContext so a tab dragged out of one TabBar can land in
  // another leaf's TabBar (cross-leaf move) instead of being constrained to
  // its source SortableContext. DragOverlay portals the dragged tab to
  // document.body so it follows the cursor without being clipped by any
  // panel's overflow / z-stack.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const reorderLeafPanesInTree = useStore((s) => s.reorderLeafPanesInTree);
  const movePaneAcrossLeaves = useStore((s) => s.movePaneAcrossLeaves);
  const swapSiblingsInTree = useStore((s) => s.swapSiblingsInTree);
  const [activeId, setActiveId] = useState<string | null>(null);
  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(String(e.active.id));
  }, []);
  // While a drag is in flight, park every browser WebContentsView offscreen
  // so the native layer doesn't swallow pointer events meant for our React
  // drop targets. Uses the shared counter hook so a dropdown + drag don't
  // step on each other's hide/show.
  useHideBrowserOverlay(activeId !== null);
  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      // PaneOverlay drag handle (swap drag).
      if (activeId.startsWith('swap:')) {
        const fromLeafId = activeId.slice(5);
        if (overId.startsWith('swap:')) {
          swapSiblingsInTree(props.groupId, fromLeafId, overId.slice(5));
        }
        return;
      }
      // Tab drag from a TabBar landing on another leaf's BODY (the leaf
      // wrap's useDroppable surfaces as "swap:<leafId>"). Move the pane
      // into that leaf as a new tab at the end.
      const paneId = activeId;
      if (overId.startsWith('swap:')) {
        const destLeafId = overId.slice(5);
        const sourceLeafForBody = findLeafContaining(props.tree, paneId);
        if (sourceLeafForBody && sourceLeafForBody.id === destLeafId) return;
        // Find destination leaf to know where to append.
        const destLeaf = (function find(n: LayoutNode): LeafNode | null {
          if (n.type === 'leaf') return n.id === destLeafId ? n : null;
          for (const c of n.children) {
            const r = find(c);
            if (r) return r;
          }
          return null;
        })(props.tree);
        if (destLeaf) {
          movePaneAcrossLeaves(props.groupId, paneId, destLeaf.id, destLeaf.panes.length);
        }
        return;
      }
      // Within-leaf reorder or cross-leaf via tab-chip target.
      const sourceLeaf = findLeafContaining(props.tree, paneId);
      const destLeaf = findLeafContaining(props.tree, overId);
      if (!sourceLeaf || !destLeaf) return;
      if (sourceLeaf.id === destLeaf.id) {
        const ids = sourceLeaf.panes.map((p) => p.id);
        const from = ids.indexOf(paneId);
        const to = ids.indexOf(overId);
        if (from < 0 || to < 0) return;
        reorderLeafPanesInTree(props.groupId, sourceLeaf.id, arrayMove(ids, from, to));
      } else {
        const destIndex = destLeaf.panes.findIndex((p) => p.id === overId);
        movePaneAcrossLeaves(
          props.groupId,
          paneId,
          destLeaf.id,
          destIndex < 0 ? destLeaf.panes.length : destIndex,
        );
      }
    },
    [props.tree, props.groupId, reorderLeafPanesInTree, movePaneAcrossLeaves],
  );
  const activePane = activeId
    ? getAllPanes(props.tree).find((p) => p.id === activeId) ?? null
    : null;
  // For a "swap:<leafId>" drag, surface the active pane of the dragged leaf
  // so the DragOverlay can show a card resembling the whole pane.
  const swapLeafPane = activeId?.startsWith('swap:')
    ? (function findLeafPane(node: LayoutNode, leafId: string): Pane | null {
        if (node.type === 'leaf') {
          if (node.id !== leafId) return null;
          return node.panes.find((p) => p.id === node.activePaneId) ?? node.panes[0] ?? null;
        }
        for (const c of node.children) {
          const r = findLeafPane(c, leafId);
          if (r) return r;
        }
        return null;
      })(props.tree, activeId.slice(5))
    : null;
  const swapLeafId = activeId?.startsWith('swap:') ? activeId.slice(5) : null;
  return (
    <WorkspaceVisibilityProvider value={props.visible ?? true}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <Node node={props.tree} {...props} activeSwapLeafId={swapLeafId} />
        <DragOverlay dropAnimation={null}>
          {swapLeafPane ? (
            <PaneCardPreview pane={swapLeafPane} />
          ) : activePane ? (
            <TabPreview pane={activePane} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </WorkspaceVisibilityProvider>
  );
}

function PreviewIcon({ kind }: { kind: PaneKind }) {
  if (kind === 'shell') return <Terminal size={12} strokeWidth={1.6} />;
  if (kind === 'claude') return <Sparkles size={12} strokeWidth={1.6} />;
  if (kind === 'diff') return <FileDiff size={12} strokeWidth={1.6} />;
  if (kind === 'files') return <FolderTree size={12} strokeWidth={1.6} />;
  if (kind === 'browser') return <Globe size={12} strokeWidth={1.6} />;
  return null;
}

// Pane-shaped drag preview used while the user drags the swap handle.
// Looks like a small thumbnail of the pane so the gesture reads as "I'm
// moving this pane", not "I'm dragging an icon".
function PaneCardPreview({ pane }: { pane: Pane }) {
  return (
    <Flex
      className="grove-drag-preview"
      direction="column"
      w="220px"
      h="140px"
      borderRadius="8px"
      bg="#0d1117"
      border="1px solid #30363d"
      boxShadow="0 16px 48px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.35)"
      overflow="hidden"
      style={{ pointerEvents: 'none' }}
    >
      <Flex
        h="28px"
        flexShrink={0}
        align="center"
        gap="2"
        px="2"
        bg="#161b22"
        borderBottom="1px solid #30363d"
      >
        <PreviewIcon kind={pane.kind} />
        <Text fontSize="11px" color="#f0f6fc" truncate>
          {pane.title}
        </Text>
      </Flex>
      <Flex flex="1" align="center" justify="center" color="#30363d">
        <PreviewIcon kind={pane.kind} />
      </Flex>
    </Flex>
  );
}

function TabPreview({ pane }: { pane: Pane }) {
  return (
    <Flex
      className="grove-drag-preview"
      align="center"
      gap="1.5"
      h="22px"
      px="2"
      borderRadius="4px"
      color="#f0f6fc"
      bg="#21262d"
      border="1px solid #30363d"
      boxShadow="0 8px 24px rgba(0,0,0,0.6)"
      style={{ pointerEvents: 'none' }}
    >
      <PreviewIcon kind={pane.kind} />
      <Text fontSize="11px" maxW="160px" truncate>
        {pane.title}
      </Text>
    </Flex>
  );
}

function Node({
  node,
  onSplitResize,
  forcedFullscreen,
  panelWidth,
  groupId,
  activeSwapLeafId,
  tree: _root,
}: LayoutHostProps & { node: LayoutNode } & NodeContext) {
  if (isLeaf(node)) {
    return (
      <Leaf
        leaf={node}
        groupId={groupId}
        forcedFullscreen={forcedFullscreen}
        panelWidth={panelWidth}
        activeSwapLeafId={activeSwapLeafId}
      />
    );
  }
  const defaultLayout: Layout = {};
  node.children.forEach((child, i) => {
    defaultLayout[child.id] = node.sizes[i];
  });
  const handleLayoutChanged = useCallback(
    (layout: Layout) => {
      if (!onSplitResize) return;
      onSplitResize(
        node.id,
        node.children.map((c) => layout[c.id] ?? 0),
      );
    },
    [node.id, node.children, onSplitResize],
  );
  return (
    <Group
      orientation={node.dir === 'h' ? 'horizontal' : 'vertical'}
      defaultLayout={defaultLayout}
      onLayoutChanged={handleLayoutChanged}
      style={{ width: '100%', height: '100%' }}
    >
      {node.children.map((child, i) => (
        <PanelFragment
          key={child.id}
          id={child.id}
          last={i === node.children.length - 1}
          dir={node.dir}
        >
          <Node
            node={child}
            onSplitResize={onSplitResize}
            tree={_root}
            groupId={groupId}
            forcedFullscreen={forcedFullscreen}
            panelWidth={panelWidth}
            activeSwapLeafId={activeSwapLeafId}
          />
        </PanelFragment>
      ))}
    </Group>
  );
}

function PanelFragment({
  children,
  id,
  last,
  dir,
}: {
  children: React.ReactNode;
  id: string;
  last: boolean;
  dir: 'h' | 'v';
}) {
  return (
    <>
      <Panel id={id} minSize={15}>
        {children}
      </Panel>
      {!last && (
        <Separator
          style={
            dir === 'h'
              ? { width: 1, background: '#21262d', cursor: 'col-resize' }
              : { height: 1, background: '#21262d', cursor: 'row-resize' }
          }
        />
      )}
    </>
  );
}

function Leaf({
  leaf,
  groupId,
  forcedFullscreen,
  panelWidth,
  activeSwapLeafId,
}: {
  leaf: LeafNode;
  groupId: string;
  forcedFullscreen: boolean;
  panelWidth: number;
  activeSwapLeafId: string | null;
}) {
  const tabPosition = useStore((s) => s.tabPosition);
  const active = leaf.panes.find((p) => p.id === leaf.activePaneId) ?? leaf.panes[0];
  // Drop target for the PaneOverlay drag handle — drop here to swap this
  // leaf with the dragged sibling in the parent split.
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `swap:${leaf.id}` });
  if (!active) return null;
  const showTabBar = tabPosition === 'top';
  const hasTerminalPanes = leaf.panes.some((p) => p.kind === 'shell' || p.kind === 'claude');
  return (
    <Flex
      ref={setDropRef}
      direction="column"
      w="100%"
      h="100%"
      bg="#0d1117"
      style={{
        outline: isOver ? '2px solid #1f6feb' : undefined,
        outlineOffset: -2,
        // Source leaf dims while its swap drag is in flight so the user sees
        // "this is the pane I'm moving" reflected in the layout itself.
        opacity: activeSwapLeafId === leaf.id ? 0.4 : 1,
        transition: 'opacity 140ms ease',
      }}
    >
      {showTabBar && <LeafTabBar leaf={leaf} groupId={groupId} />}
      <Box flex="1" minH="0" position="relative">
        {/* Terminal-backed panes for this leaf are mounted here (per-leaf,
            lazy) so multiple leaves can each show their own shell/claude.
            Hidden when the active pane is a panel — but kept mounted so we
            don't kill ptys when the user toggles to a panel and back. */}
        {hasTerminalPanes && (
          <Box
            position="absolute"
            inset="0"
            display={active.kind === 'shell' || active.kind === 'claude' ? 'block' : 'none'}
          >
            <LeafTerminalHost leaf={leaf} />
          </Box>
        )}
        {active.kind !== 'shell' && active.kind !== 'claude' && (
          <PaneContent pane={active} forcedFullscreen={forcedFullscreen} panelWidth={panelWidth} />
        )}
        {!showTabBar && <PaneOverlay leaf={leaf} groupId={groupId} />}
      </Box>
    </Flex>
  );
}

function PaneContent({
  pane,
  forcedFullscreen,
  panelWidth,
}: {
  pane: Pane;
  forcedFullscreen: boolean;
  panelWidth: number;
}) {
  const panels = usePanels();
  // Terminal panes are rendered by LeafTerminalHost at the Leaf level (so the
  // mounted-set is per-leaf). PaneContent only handles panel panes.
  if (pane.kind === 'shell' || pane.kind === 'claude') return null;
  // Registry is keyed by *kind* (the renderer); pane.id is a per-instance
  // uid so two Diff panes get the same registered DiffPanel component but
  // distinct paneId props.
  const panel = panels.find((p) => p.id === pane.kind);
  if (!panel) return null;
  return (
    <Suspense fallback={<PanelLoading />}>
      <panel.component
        paneId={pane.id}
        forcedFullscreen={forcedFullscreen}
        panelWidth={panelWidth}
      />
    </Suspense>
  );
}

function PanelLoading() {
  return (
    <Flex h="100%" w="100%" align="center" justify="center" bg="#010409">
      <SquareLoader />
    </Flex>
  );
}
