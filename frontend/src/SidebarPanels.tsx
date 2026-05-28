// Slim list of open panels (Diff / Files / Browser) under each workspace in
// the sidebar. Walks the workspace's layoutTreeByGroup and surfaces panel
// panes so the user can jump to or close one without hunting through leaves.

import { Box, Flex, Text } from '@chakra-ui/react';
import { FileDiff, FolderTree, Globe, X } from 'lucide-react';
import { useStore } from './store';
import { getAllPanes } from './layout/treeOps';
import type { Pane, PaneKind } from './layout/types';

const PANEL_KINDS = new Set<PaneKind>(['diff', 'files', 'browser']);

function PaneIcon({ kind }: { kind: PaneKind }) {
  if (kind === 'diff') return <FileDiff size={13} strokeWidth={1.6} />;
  if (kind === 'files') return <FolderTree size={13} strokeWidth={1.6} />;
  if (kind === 'browser') return <Globe size={13} strokeWidth={1.6} />;
  return null;
}

export function GroupPanels({ groupId }: { groupId: string }) {
  const tree = useStore((s) => s.layoutTreeByGroup[groupId]);
  const removePaneFromTree = useStore((s) => s.removePaneFromTree);
  const setActivePaneInTree = useStore((s) => s.setActivePaneInTree);
  const activePanelId = useStore((s) => s.activePanelId);
  if (!tree) return null;
  const panels = getAllPanes(tree).filter((p): p is Pane => PANEL_KINDS.has(p.kind));
  if (panels.length === 0) return null;
  return (
    <Flex direction="column" gap="0.5" pt="1">
      {panels.map((p) => {
        const isActive = activePanelId === p.id;
        return (
          <Flex
            key={p.id}
            align="center"
            gap="2"
            px="2"
            ml="6"
            mr="1"
            h="24px"
            borderRadius="4px"
            cursor="pointer"
            color={isActive ? '#f0f6fc' : '#7d8590'}
            bg={isActive ? '#1f2937' : 'transparent'}
            _hover={{ bg: isActive ? '#1f2937' : '#161b22', '& .panel-close': { opacity: 1 } }}
            onClick={() => {
              setActivePaneInTree(groupId, p.id);
              useStore.setState({ activePanelId: p.id });
            }}
          >
            <Box flexShrink={0}>
              <PaneIcon kind={p.kind} />
            </Box>
            <Text fontSize="12px" flex="1" minW="0" truncate>
              {p.title}
            </Text>
            <Box
              as="button"
              className="panel-close"
              opacity={0}
              p="0"
              w="16px"
              h="16px"
              display="flex"
              alignItems="center"
              justifyContent="center"
              borderRadius="3px"
              bg="transparent"
              border="none"
              color="#7d8590"
              cursor="pointer"
              _hover={{ bg: '#30363d', color: '#f0f6fc' }}
              onClick={(e) => {
                e.stopPropagation();
                removePaneFromTree(groupId, p.id);
                if (activePanelId === p.id) {
                  useStore.setState({ activePanelId: null });
                }
              }}
              style={{ transition: 'opacity 120ms ease' }}
            >
              <X size={11} strokeWidth={2} />
            </Box>
          </Flex>
        );
      })}
    </Flex>
  );
}
