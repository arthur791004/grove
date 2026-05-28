// Walks a LayoutNode tree and renders it. Splits use react-resizable-panels
// v4 (Group / Panel / Separator) for a draggable divider; leaves render the
// existing Workspace component (for the workspace's tabs) or a panel registry
// component (for diff / files / browser). Slice 1+2 only needs to handle two
// shapes — single leaf, and a horizontal split with one workspace leaf + one
// panel leaf — but the walker is generic so slices 4-5 can add splits without
// changing this file.

import { Suspense, useCallback } from 'react';
import { Box, Flex } from '@chakra-ui/react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { Workspace } from '../Workspace';
import { SquareLoader } from '../SquareLoader';
import { useStore } from '../store';
import { usePanels } from '../extensions/registry';
import { PaneOverlay } from './PaneOverlay';
import { LeafTabBar } from './LeafTabBar';
import type { LayoutNode, LeafNode, Pane } from './types';
import { isLeaf } from './types';

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
}

export function LayoutHost(props: LayoutHostProps) {
  return <Node node={props.tree} {...props} />;
}

function Node({
  node,
  onSplitResize,
  forcedFullscreen,
  panelWidth,
  groupId,
  tree: _root,
}: LayoutHostProps & { node: LayoutNode }) {
  if (isLeaf(node)) {
    return (
      <Leaf
        leaf={node}
        groupId={groupId}
        forcedFullscreen={forcedFullscreen}
        panelWidth={panelWidth}
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
}: {
  leaf: LeafNode;
  groupId: string;
  forcedFullscreen: boolean;
  panelWidth: number;
}) {
  const tabPosition = useStore((s) => s.tabPosition);
  const active = leaf.panes.find((p) => p.id === leaf.activePaneId) ?? leaf.panes[0];
  if (!active) return null;
  // In top mode every leaf gets a browser-style TabBar above its content; the
  // PaneOverlay close/split affordance is suppressed because the TabBar
  // already exposes both via per-tab X and the leaf's split menu.
  const showTabBar = tabPosition === 'top';
  return (
    <Flex direction="column" w="100%" h="100%" bg="#0d1117">
      {showTabBar && <LeafTabBar leaf={leaf} groupId={groupId} />}
      <Box flex="1" minH="0" position="relative">
        <PaneContent pane={active} forcedFullscreen={forcedFullscreen} panelWidth={panelWidth} />
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
  if (pane.kind === 'shell' || pane.kind === 'claude') {
    // The legacy Workspace already lazy-mounts each tab and shows only the
    // active one. As long as exactly one workspace leaf exists it's safe to
    // reuse — slice 3 will replace this with a per-leaf renderer.
    return <Workspace />;
  }
  const panel = panels.find((p) => p.id === pane.id);
  if (!panel) return null;
  return (
    <Suspense fallback={<PanelLoading />}>
      <panel.component forcedFullscreen={forcedFullscreen} panelWidth={panelWidth} />
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
