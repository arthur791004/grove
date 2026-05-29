// Slim list of open panels (Diff / Files / Browser) under each workspace in
// the sidebar. Walks the workspace's layoutTreeByGroup and surfaces panel
// panes so the user can jump to or close one without hunting through leaves.

import { useState } from 'react';
import { Box, Flex, Text } from '@chakra-ui/react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FileDiff, FolderTree, Globe, X } from 'lucide-react';
import { useStore } from './store';
import { getAllPanes } from './layout/treeOps';
import { SplitContextMenu } from './SidebarKindMenu';
import type { Pane, PaneKind } from './layout/types';

const PANEL_KINDS = new Set<PaneKind>(['diff', 'files', 'browser']);

function PaneIcon({ kind }: { kind: PaneKind }) {
  if (kind === 'diff') return <FileDiff size={13} strokeWidth={1.6} />;
  if (kind === 'files') return <FolderTree size={13} strokeWidth={1.6} />;
  if (kind === 'browser') return <Globe size={13} strokeWidth={1.6} />;
  return null;
}

// Single panel row component — used by GroupPanels and by the per-leaf
// sidebar rendering so the styles stay in sync.
export function PanelRow({
  pane,
  groupId,
  sortId,
}: {
  pane: Pane;
  groupId: string;
  // When present, registers the row as a sortable item under this id so the
  // sidebar dnd reorders panels alongside tabs.
  sortId?: string;
}) {
  const removePaneFromTree = useStore((s) => s.removePaneFromTree);
  const setActivePaneInTree = useStore((s) => s.setActivePaneInTree);
  const activePanelId = useStore((s) => s.activePanelId);
  const [menu, setMenu] = useState<{
    pos: { top: number; left: number };
  } | null>(null);
  const isActive = activePanelId === pane.id;
  // Registers this row with the sidebar's DndContext (when sortId is given)
  // so panels reorder alongside tabs and split groups using the same gesture.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortId ?? pane.id,
  });
  const sortableStyle = sortId
    ? {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }
    : undefined;
  return (
    <>
      <Flex
        ref={sortId ? setNodeRef : undefined}
        style={sortableStyle}
        {...(sortId ? attributes : {})}
        {...(sortId ? listeners : {})}
        align="center"
        gap="1.5"
        px="1.5"
        h="32px"
        borderRadius="6px"
        cursor="pointer"
        bg={isActive ? '#21262d' : 'transparent'}
        _hover={{
          bg: isActive ? '#21262d' : '#161b22',
          '& .panel-close': { opacity: 1 },
        }}
        onClick={() => {
          setActivePaneInTree(groupId, pane.id);
          useStore.setState({ activePanelId: pane.id });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ pos: { top: e.clientY, left: e.clientX } });
        }}
      >
        <Box w="10px" h="20px" flexShrink={0} />
        <Box
          w="20px"
          h="20px"
          borderRadius="4px"
          bg="#0d1117"
          border="1px solid #30363d"
          display="flex"
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
          color="#7d8590"
        >
          <PaneIcon kind={pane.kind} />
        </Box>
        <Text
          fontSize="12px"
          flex="1"
          minW="0"
          truncate
          color={isActive ? '#f0f6fc' : '#c9d1d9'}
          fontWeight={isActive ? 500 : 400}
        >
          {pane.title}
        </Text>
        <Box
          as="button"
          className="panel-close"
          opacity={0}
          w="18px"
          h="18px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          borderRadius="3px"
          bg="transparent"
          border="none"
          color="#7d8590"
          cursor="pointer"
          flexShrink={0}
          mr="0.5"
          _hover={{ bg: '#30363d', color: '#f0f6fc' }}
          onClick={(e) => {
            e.stopPropagation();
            // removePaneFromTree already shifts focus to a sibling in the
            // same top-level tab — don't trample its activePanelId update.
            removePaneFromTree(groupId, pane.id);
          }}
          style={{ transition: 'opacity 120ms ease' }}
        >
          <X size={12} strokeWidth={2} />
        </Box>
      </Flex>
      {menu && (
        <SplitContextMenu
          groupId={groupId}
          paneId={pane.id}
          pos={menu.pos}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

export function GroupPanels({ groupId }: { groupId: string }) {
  const tree = useStore((s) => s.layoutTreeByGroup[groupId]);
  if (!tree) return null;
  const panels = getAllPanes(tree).filter((p): p is Pane => PANEL_KINDS.has(p.kind));
  if (panels.length === 0) return null;
  return (
    <Flex direction="column" gap="0.5" pt="1">
      {panels.map((p) => (
        <PanelRow key={p.id} pane={p} groupId={groupId} />
      ))}
    </Flex>
  );
}
