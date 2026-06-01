// Floating top-right overlay shown above panel leaves (diff / files /
// browser). Gives the user close + split-with affordances without crowding
// the panel's own internal header. Workspace leaves (shell / claude tabs)
// don't get this overlay — those tabs live in the sidebar today.

import { useState, useRef } from 'react';
import { Box, Flex } from '@chakra-ui/react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { X, Columns2, GripVertical, Rows2 } from 'lucide-react';
import { useStore, makePanelPane } from '../store';
import { showPopupMenu } from '../showPopupMenu';
import type { LeafNode, Pane, PaneKind } from './types';

const SPLIT_KIND_LABELS: Array<{ kind: PaneKind; label: string }> = [
  { kind: 'shell', label: 'Terminal' },
  { kind: 'claude', label: 'Claude' },
  { kind: 'diff', label: 'Diff' },
  { kind: 'files', label: 'Files' },
  { kind: 'browser', label: 'Browser' },
];

const PANEL_KINDS = new Set<PaneKind>(['diff', 'files', 'browser']);

export function PaneOverlay({ leaf, groupId }: { leaf: LeafNode; groupId: string }) {
  const active = leaf.panes.find((p) => p.id === leaf.activePaneId) ?? leaf.panes[0];
  if (!active) return null;
  return (
    <Box
      position="absolute"
      top="6px"
      right="8px"
      zIndex={20}
      display="flex"
      gap="2px"
      bg="rgba(13,17,23,0.85)"
      borderRadius="4px"
      px="2px"
      py="2px"
      style={{ backdropFilter: 'blur(4px)' }}
    >
      <PaneDragHandle leafId={leaf.id} />
      <SplitButton leaf={leaf} groupId={groupId} dir="h" />
      <SplitButton leaf={leaf} groupId={groupId} dir="v" />
      <CloseButton leaf={leaf} pane={active} groupId={groupId} />
    </Box>
  );
}

// Drag this handle onto an adjacent sibling pane (in the same split) to
// swap their positions. Source id is namespaced "swap:<leafId>" so the
// global LayoutHost dnd handler routes it to the swap action instead of
// the tab-reorder action.
function PaneDragHandle({ leafId }: { leafId: string }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `swap:${leafId}`,
  });
  return (
    <Flex
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.5 : 1,
        cursor: 'grab',
      }}
      {...attributes}
      {...listeners}
      align="center"
      justify="center"
      w="20px"
      h="22px"
      borderRadius="3px"
      bg="transparent"
      color="#7d8590"
      _hover={{ bg: '#21262d', color: '#f0f6fc' }}
      title="Drag to swap with another pane in this split"
    >
      <GripVertical size={13} strokeWidth={1.8} />
    </Flex>
  );
}

function CloseButton({ leaf, pane, groupId }: { leaf: LeafNode; pane: Pane; groupId: string }) {
  const removePaneFromTree = useStore((s) => s.removePaneFromTree);
  const closeTab = useStore((s) => s.closeTab);
  const activePanelId = useStore((s) => s.activePanelId);
  const isTerminal = pane.kind === 'shell' || pane.kind === 'claude';
  return (
    <OverlayIconButton
      title={`Close ${pane.title.toLowerCase()}`}
      onClick={() => {
        if (isTerminal) {
          closeTab(pane.id);
        } else {
          // removePaneFromTree handles the focus shift to a sibling pane
          // within the same top-level tab — don't override here.
          removePaneFromTree(groupId, pane.id);
        }
        void leaf;
      }}
    >
      <X size={13} strokeWidth={1.8} />
    </OverlayIconButton>
  );
}

function SplitButton({
  leaf,
  groupId,
  dir,
}: {
  leaf: LeafNode;
  groupId: string;
  dir: 'h' | 'v';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const splitLeafInTree = useStore((s) => s.splitLeafInTree);
  const splitLeafWithNewTab = useStore((s) => s.splitLeafWithNewTab);

  // Render a custom-styled dropdown in whichever renderer hosts the modal
  // layer (overlay window in Electron, main renderer in web). The styled
  // menu matches Grove's dark theme and avoids the WebContentsView
  // z-fight because in Electron it paints in the overlay window above
  // every Chromium layer.
  const onClick = async () => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const picked = await showPopupMenu(
      SPLIT_KIND_LABELS.map(({ kind, label }) => ({ id: kind, label })),
      { x: r.left, y: r.bottom + 4 },
    );
    if (!picked) return;
    const kind = picked as (typeof SPLIT_KIND_LABELS)[number]['kind'];
    if (kind === 'shell' || kind === 'claude') {
      splitLeafWithNewTab(groupId, leaf.id, dir, kind);
      return;
    }
    const { pane, state } = makePanelPane(kind);
    splitLeafInTree(groupId, leaf.id, dir, pane, true);
    useStore.setState((prev) => ({
      activePanelId: pane.id,
      paneState: { ...prev.paneState, [pane.id]: state },
    }));
  };

  return (
    <Box ref={ref} position="relative">
      <OverlayIconButton
        title={dir === 'h' ? 'Split right' : 'Split down'}
        onClick={onClick}
      >
        {dir === 'h' ? (
          <Columns2 size={13} strokeWidth={1.8} />
        ) : (
          <Rows2 size={13} strokeWidth={1.8} />
        )}
      </OverlayIconButton>
    </Box>
  );
}

function OverlayIconButton({
  title,
  onClick,
  active,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const bg = active ? '#30363d' : hover ? '#21262d' : 'transparent';
  return (
    <Flex
      as="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      align="center"
      justify="center"
      w="22px"
      h="22px"
      borderRadius="3px"
      style={{
        background: bg,
        border: 'none',
        color: '#c9d1d9',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms ease',
      }}
    >
      {children}
    </Flex>
  );
}
