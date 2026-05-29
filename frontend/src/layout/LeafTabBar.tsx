// Browser-style TabBar rendered above each leaf when `tabPosition === 'top'`.
// Lists the leaf's panes as clickable tabs; trailing `+ ▾` opens a kind
// picker so the user can add a Terminal / Claude / Diff / Files / Browser as
// a new pane in this leaf; trailing split menu splits the leaf horizontally
// or vertically with another panel.
//
// Tabs are draggable via @dnd-kit/sortable for within-leaf reordering.
// Cross-leaf drag deferred — would need a global DndContext and movePane
// store action.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, Flex, Text } from '@chakra-ui/react';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Columns2,
  FileDiff,
  FolderTree,
  Globe,
  Plus,
  Rows2,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { useStore, makePanelPane } from '../store';
import { useHideBrowserOverlay } from '../useHideBrowserOverlay';
import { NewPaneContextMenu } from '../SidebarKindMenu';
import type { LayoutNode, LeafNode, Pane, PaneKind } from './types';

function PaneIcon({ kind, size = 12 }: { kind: PaneKind; size?: number }) {
  if (kind === 'shell') return <Terminal size={size} strokeWidth={1.6} />;
  if (kind === 'claude') return <Sparkles size={size} strokeWidth={1.6} />;
  if (kind === 'diff') return <FileDiff size={size} strokeWidth={1.6} />;
  if (kind === 'files') return <FolderTree size={size} strokeWidth={1.6} />;
  if (kind === 'browser') return <Globe size={size} strokeWidth={1.6} />;
  return null;
}

export function LeafTabBar({ leaf, groupId }: { leaf: LeafNode; groupId: string }) {
  // SortableContext only — the DndContext lives at LayoutHost so a drag can
  // cross between leaves. Within-leaf reorder and cross-leaf move are both
  // resolved there in a single dragEnd handler.
  const [ctxMenu, setCtxMenu] = useState<{ top: number; left: number } | null>(null);
  return (
    <>
      <Flex
        h="30px"
        flexShrink={0}
        align="center"
        bg="#0d1117"
        borderBottom="1px solid #21262d"
        px="1"
        gap="1"
        overflowX="auto"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ top: e.clientY, left: e.clientX });
        }}
      >
        <SortableContext
          items={leaf.panes.map((p) => p.id)}
          strategy={horizontalListSortingStrategy}
        >
          <Flex align="center" gap="1" flex="1" minW="0">
            {leaf.panes.map((p) => (
              <TabChip key={p.id} pane={p} leaf={leaf} groupId={groupId} />
            ))}
          </Flex>
        </SortableContext>
        <Flex align="center" gap="0" ml="auto">
          <NewTabButton leaf={leaf} groupId={groupId} />
          <SplitButton leaf={leaf} groupId={groupId} />
        </Flex>
      </Flex>
      {ctxMenu && (
        <NewPaneContextMenu groupId={groupId} pos={ctxMenu} onClose={() => setCtxMenu(null)} />
      )}
    </>
  );
}

function TabChip({ pane, leaf, groupId }: { pane: Pane; leaf: LeafNode; groupId: string }) {
  const active = leaf.activePaneId === pane.id;
  const setActivePaneInTree = useStore((s) => s.setActivePaneInTree);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const removePaneFromTree = useStore((s) => s.removePaneFromTree);
  const closeTab = useStore((s) => s.closeTab);
  const activePanelId = useStore((s) => s.activePanelId);
  const isTerminal = pane.kind === 'shell' || pane.kind === 'claude';
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: pane.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <Flex
      ref={setNodeRef}
      align="center"
      gap="1.5"
      h="22px"
      px="2"
      borderRadius="4px"
      cursor="pointer"
      flexShrink={0}
      color={active ? '#f0f6fc' : '#7d8590'}
      bg={active ? '#21262d' : 'transparent'}
      _hover={{ bg: active ? '#21262d' : '#161b22', '& .tab-close': { opacity: 1 } }}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => {
        setActivePaneInTree(groupId, pane.id);
        if (isTerminal) setActiveTab(pane.id);
        else useStore.setState({ activePanelId: pane.id });
      }}
    >
      <PaneIcon kind={pane.kind} />
      <Text fontSize="11px" maxW="140px" truncate>
        {pane.title}
      </Text>
      <Box
        as="button"
        className="tab-close"
        opacity={active ? 0.7 : 0}
        ml="0.5"
        w="14px"
        h="14px"
        display="flex"
        alignItems="center"
        justifyContent="center"
        borderRadius="3px"
        bg="transparent"
        border="none"
        color="inherit"
        cursor="pointer"
        _hover={{ bg: '#30363d', color: '#f0f6fc' }}
        style={{ transition: 'opacity 120ms ease' }}
        onClick={(e) => {
          e.stopPropagation();
          if (isTerminal) {
            closeTab(pane.id);
          } else {
            // removePaneFromTree handles the focus shift to a sibling pane
            // within the same top-level tab.
            removePaneFromTree(groupId, pane.id);
          }
        }}
        onPointerDown={(e) => {
          // Prevent the sortable listeners from claiming this click as a
          // drag-start (otherwise the close button can swallow the click).
          e.stopPropagation();
        }}
      >
        <X size={10} strokeWidth={2} />
      </Box>
    </Flex>
  );
}

// Split-into options: terminal/claude create a fresh tab as the new leaf;
// diff/files/browser become a panel leaf alongside.
const SPLIT_KINDS: Array<{ kind: PaneKind; label: string }> = [
  { kind: 'shell', label: 'Terminal' },
  { kind: 'claude', label: 'Claude' },
  { kind: 'diff', label: 'Diff' },
  { kind: 'files', label: 'Files' },
  { kind: 'browser', label: 'Browser' },
];

function useDropdown() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useHideBrowserOverlay(open);
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const place = () => {
      const r = triggerRef.current!.getBoundingClientRect();
      // Keep the menu fully on-screen — if the trigger sits closer than 8px
      // to the right edge (or off it due to overflow), pad in.
      const right = Math.max(8, window.innerWidth - r.right);
      setPos({ top: r.bottom + 4, right });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const inTrigger = triggerRef.current && triggerRef.current.contains(e.target as Node);
      const inMenu = menuRef.current && menuRef.current.contains(e.target as Node);
      if (!inTrigger && !inMenu) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return { open, setOpen, triggerRef, menuRef, pos };
}

function NewTabButton({ leaf, groupId }: { leaf: LeafNode; groupId: string }) {
  const defaultKind = useStore((s) => s.newTabMode);
  const addPaneToLeafInTree = useStore((s) => s.addPaneToLeafInTree);
  const newTab = useStore((s) => s.newTab);
  const setActivePaneInTree = useStore((s) => s.setActivePaneInTree);
  const treeForGroup = useStore((s) => s.layoutTreeByGroup[groupId]);

  const addPane = (kind: PaneKind) => {
    if (kind === 'shell' || kind === 'claude') {
      // Top-mode TabBar `+` adds inside the leaf the user clicked, not as a
      // new top-level tab. (Sidebar `+` continues to use the default path.)
      newTab(groupId, undefined, { mode: kind, inLeafId: leaf.id });
      return;
    }
    // Always mint a fresh instance — multiple Diff / Files / Browser panes
    // per workspace each carry their own state.
    const { pane, state } = makePanelPane(kind);
    addPaneToLeafInTree(groupId, leaf.id, pane);
    setActivePaneInTree(groupId, pane.id);
    useStore.setState((prev) => ({
      activePanelId: pane.id,
      paneState: { ...prev.paneState, [pane.id]: state },
    }));
    void treeForGroup;
  };

  return (
    <OverlayButton
      onClick={() => addPane(defaultKind)}
      title={`New ${defaultKind} tab — right-click bar for more`}
    >
      <Plus size={13} strokeWidth={2} />
    </OverlayButton>
  );
}

function SplitButton({ leaf, groupId }: { leaf: LeafNode; groupId: string }) {
  const { open, setOpen, triggerRef, menuRef, pos } = useDropdown();
  const splitLeafInTree = useStore((s) => s.splitLeafInTree);
  const splitLeafWithNewTab = useStore((s) => s.splitLeafWithNewTab);
  const setActivePaneInTree = useStore((s) => s.setActivePaneInTree);
  const treeForGroup = useStore((s) => s.layoutTreeByGroup[groupId]);
  const [pendingDir, setPendingDir] = useState<'h' | 'v' | null>(null);

  const doSplit = (dir: 'h' | 'v', kind: PaneKind) => {
    setOpen(false);
    setPendingDir(null);
    if (kind === 'shell' || kind === 'claude') {
      // Spawns a fresh terminal-backed tab in its own new leaf.
      splitLeafWithNewTab(groupId, leaf.id, dir, kind);
      return;
    }
    // Fresh instance — panel kinds aren't singletons anymore.
    const { pane, state } = makePanelPane(kind);
    splitLeafInTree(groupId, leaf.id, dir, pane, true);
    setActivePaneInTree(groupId, pane.id);
    useStore.setState((prev) => ({
      activePanelId: pane.id,
      paneState: { ...prev.paneState, [pane.id]: state },
    }));
    void treeForGroup;
  };

  return (
    <Flex ref={triggerRef} position="relative" align="center" gap="0" ml="1">
      <OverlayButton
        onClick={() => {
          setPendingDir('h');
          setOpen(true);
        }}
        active={open && pendingDir === 'h'}
        title="Split right with…"
      >
        <Columns2 size={13} strokeWidth={1.8} />
      </OverlayButton>
      <OverlayButton
        onClick={() => {
          setPendingDir('v');
          setOpen(true);
        }}
        active={open && pendingDir === 'v'}
        title="Split down with…"
      >
        <Rows2 size={13} strokeWidth={1.8} />
      </OverlayButton>
      {open &&
        pos &&
        pendingDir &&
        createPortal(
          <DropdownMenu menuRef={menuRef} pos={pos}>
            {SPLIT_KINDS.map(({ kind, label }) => (
              <DropdownItem
                key={kind}
                icon={<PaneIcon kind={kind} size={13} />}
                onClick={() => doSplit(pendingDir, kind)}
              >
                {label}
              </DropdownItem>
            ))}
          </DropdownMenu>,
          document.body,
        )}
    </Flex>
  );
}

function DropdownMenu({
  menuRef,
  pos,
  children,
}: {
  menuRef: React.RefObject<HTMLDivElement>;
  pos: { top: number; right: number };
  children: React.ReactNode;
}) {
  return (
    <Box
      ref={menuRef}
      position="fixed"
      top={`${pos.top}px`}
      right={`${pos.right}px`}
      bg="#161b22"
      border="1px solid #30363d"
      borderRadius="6px"
      boxShadow="0 10px 30px rgba(0,0,0,0.5)"
      py="1"
      minW="160px"
      zIndex={3000}
    >
      {children}
    </Box>
  );
}

function DropdownItem({
  icon,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Flex
      as="button"
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
      onClick={onClick}
    >
      <Box w="14px" display="flex" alignItems="center">
        {icon}
      </Box>
      {children}
    </Flex>
  );
}

function OverlayButton({
  onClick,
  active,
  title,
  width = '22px',
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <Flex
      as="button"
      align="center"
      justify="center"
      w={width}
      h="22px"
      borderRadius="3px"
      bg={active ? '#21262d' : 'transparent'}
      border="none"
      color="#7d8590"
      cursor="pointer"
      _hover={{ bg: '#21262d', color: '#f0f6fc' }}
      onClick={onClick}
      title={title}
    >
      {children}
    </Flex>
  );
}

function treeHasPane(tree: LayoutNode, paneId: string): boolean {
  return tree.type === 'leaf'
    ? tree.panes.some((p) => p.id === paneId)
    : tree.children.some((c) => treeHasPane(c, paneId));
}
