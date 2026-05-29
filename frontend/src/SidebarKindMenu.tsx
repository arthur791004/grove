// Sidebar / TabBar affordances that surface the layout-tree actions:
//
// - <NewPaneButton>: a single `+` button (no dropdown) that adds the default
//   kind (shell/claude per Settings → Tabs). Other kinds come from the
//   right-click context menus that wrap workspaces and tab bars — same
//   actions in both sidebar and top modes.
// - <SplitContextMenu>: portal'd right-click menu shown for sidebar panel
//   rows; splits the row's pane into its own sibling leaf via
//   splitOffPaneInTree.
// - addPaneOfKind / ALL_PANE_KINDS / PaneIcon: small shared building blocks
//   the workspace and leaf right-click menus consume.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Box, Flex, Text } from '@chakra-ui/react';
import { FileDiff, FolderTree, Globe, Plus, Sparkles, Terminal } from 'lucide-react';
import { useStore, makePanelPane } from './store';
import { useHideBrowserOverlay } from './useHideBrowserOverlay';
import { makeLeaf, splitRight } from './layout/treeOps';
import type { PaneKind } from './layout/types';

export function PaneIcon({ kind, size = 13 }: { kind: PaneKind; size?: number }) {
  if (kind === 'shell') return <Terminal size={size} strokeWidth={1.6} />;
  if (kind === 'claude') return <Sparkles size={size} strokeWidth={1.6} />;
  if (kind === 'diff') return <FileDiff size={size} strokeWidth={1.6} />;
  if (kind === 'files') return <FolderTree size={size} strokeWidth={1.6} />;
  if (kind === 'browser') return <Globe size={size} strokeWidth={1.6} />;
  return null;
}

export const ALL_PANE_KINDS: ReadonlyArray<{ kind: PaneKind; label: string }> = [
  { kind: 'shell', label: 'Terminal' },
  { kind: 'claude', label: 'Claude' },
  { kind: 'diff', label: 'Diff' },
  { kind: 'files', label: 'Files' },
  { kind: 'browser', label: 'Browser' },
];

// Add a pane of the given kind to a workspace, focusing it. Singleton panel
// kinds (diff/files/browser) get focused-in-place if already open in this
// workspace's tree. Defensively expands the workspace row in case some
// upstream click handler collapsed it.
export function addPaneOfKind(groupId: string, kind: PaneKind): void {
  const s = useStore.getState();
  const ensureExpanded = () => {
    const g = useStore.getState().groups.find((x) => x.id === groupId);
    if (g?.collapsed) useStore.getState().toggleGroup(groupId);
  };
  if (kind === 'shell' || kind === 'claude') {
    s.newTab(groupId, undefined, { mode: kind });
    queueMicrotask(ensureExpanded);
    return;
  }
  // Panel kinds: add as a new top-level leaf — own tab, own sidebar row.
  // Main screen still shows only the active top-level entry.
  const { pane, state } = makePanelPane(kind);
  useStore.setState((prev) => {
    const tree = prev.layoutTreeByGroup[groupId] ?? makeLeaf([]);
    const newLeaf = makeLeaf([pane]);
    const nextTree =
      tree.type === 'leaf' && tree.panes.length === 0
        ? newLeaf
        : splitRight(tree, newLeaf, 50);
    return {
      activePanelId: pane.id,
      paneState: { ...prev.paneState, [pane.id]: state },
      layoutTreeByGroup: { ...prev.layoutTreeByGroup, [groupId]: nextTree },
    };
  });
  queueMicrotask(ensureExpanded);
}

export function NewPaneButton({ groupId }: { groupId: string }) {
  const defaultMode = useStore((s) => s.newTabMode);
  return (
    <button
      title={`New ${defaultMode} tab — right-click workspace for more`}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        addPaneOfKind(groupId, defaultMode);
      }}
      style={{
        background: 'transparent',
        border: 'none',
        color: '#7d8590',
        cursor: 'pointer',
        width: 20,
        height: 20,
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
      }}
    >
      <Plus size={13} strokeWidth={2} />
    </button>
  );
}

export function SplitContextMenu({
  groupId,
  paneId,
  pos,
  onClose,
}: {
  groupId: string;
  paneId: string;
  pos: { top: number; left: number };
  onClose: () => void;
}) {
  useHideBrowserOverlay(true);
  const splitOffPaneInTree = useStore((s) => s.splitOffPaneInTree);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);
  const split = (dir: 'h' | 'v') => {
    splitOffPaneInTree(groupId, paneId, dir, true);
    onClose();
  };
  return createPortal(
    <Box
      ref={menuRef}
      position="fixed"
      top={`${pos.top}px`}
      left={`${pos.left}px`}
      bg="#161b22"
      border="1px solid #30363d"
      borderRadius="6px"
      boxShadow="0 10px 30px rgba(0,0,0,0.5)"
      py="1"
      minW="180px"
      zIndex={3000}
    >
      <Item onClick={() => split('h')}>Open in split right</Item>
      <Item onClick={() => split('v')}>Open in split down</Item>
    </Box>,
    document.body,
  );
}

// Portal'd right-click menu listing the five pane kinds. Used by both
// workspace rows (to add a tab without going through Settings) and TabBar
// empty-space right-click (top mode).
export function NewPaneContextMenu({
  groupId,
  pos,
  onClose,
}: {
  groupId: string;
  pos: { top: number; left: number };
  onClose: () => void;
}) {
  useHideBrowserOverlay(true);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);
  return createPortal(
    <Box
      ref={menuRef}
      position="fixed"
      top={`${pos.top}px`}
      left={`${pos.left}px`}
      bg="#161b22"
      border="1px solid #30363d"
      borderRadius="6px"
      boxShadow="0 10px 30px rgba(0,0,0,0.5)"
      py="1"
      minW="180px"
      zIndex={3000}
    >
      <Box px="3" py="1">
        <Text fontSize="10px" color="#7d8590" textTransform="uppercase" letterSpacing="0.06em">
          New tab
        </Text>
      </Box>
      {ALL_PANE_KINDS.map(({ kind, label }) => (
        <Flex
          as="button"
          key={kind}
          w="100%"
          align="center"
          gap="2"
          px="3"
          py="1.5"
          cursor="pointer"
          bg="transparent"
          border="none"
          color="#f0f6fc"
          fontSize="12px"
          _hover={{ bg: '#1f6feb' }}
          onClick={() => {
            addPaneOfKind(groupId, kind);
            onClose();
          }}
        >
          <Box w="14px" display="flex" alignItems="center">
            <PaneIcon kind={kind} />
          </Box>
          {label}
        </Flex>
      ))}
    </Box>,
    document.body,
  );
}

function Item({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <Flex
      as="button"
      w="100%"
      align="center"
      px="3"
      py="1.5"
      cursor="pointer"
      bg="transparent"
      border="none"
      color="#f0f6fc"
      fontSize="12px"
      _hover={{ bg: '#1f6feb' }}
      onClick={onClick}
    >
      <Text fontSize="12px">{children}</Text>
    </Flex>
  );
}
