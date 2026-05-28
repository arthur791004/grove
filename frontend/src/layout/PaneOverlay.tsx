// Floating top-right overlay shown above panel leaves (diff / files /
// browser). Gives the user close + split-with affordances without crowding
// the panel's own internal header. Workspace leaves (shell / claude tabs)
// don't get this overlay — those tabs live in the sidebar today.

import { useState, useRef, useEffect } from 'react';
import { Box, Flex, Text } from '@chakra-ui/react';
import { X, Columns2, Rows2 } from 'lucide-react';
import { useStore } from '../store';
import { usePanels } from '../extensions/registry';
import type { LeafNode, Pane, PaneKind } from './types';

const PANEL_KINDS = new Set<PaneKind>(['diff', 'files', 'browser']);

export function PaneOverlay({ leaf, groupId }: { leaf: LeafNode; groupId: string }) {
  const active = leaf.panes.find((p) => p.id === leaf.activePaneId) ?? leaf.panes[0];
  if (!active || !PANEL_KINDS.has(active.kind)) return null;
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
      <SplitButton leaf={leaf} groupId={groupId} dir="h" />
      <SplitButton leaf={leaf} groupId={groupId} dir="v" />
      <CloseButton leaf={leaf} pane={active} groupId={groupId} />
    </Box>
  );
}

function CloseButton({ leaf, pane, groupId }: { leaf: LeafNode; pane: Pane; groupId: string }) {
  const removePaneFromTree = useStore((s) => s.removePaneFromTree);
  const activePanelId = useStore((s) => s.activePanelId);
  return (
    <OverlayIconButton
      title={`Close ${pane.title.toLowerCase()}`}
      onClick={() => {
        removePaneFromTree(groupId, pane.id);
        // Keep `activePanelId` in sync for legacy consumers (titlebar
        // highlight, panel-internal fullscreen reads).
        if (activePanelId === pane.id) {
          useStore.setState({ activePanelId: null });
        }
        // Silence unused `leaf` lint while keeping the API symmetrical with
        // SplitButton (which needs the leaf id).
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panels = usePanels();
  const splitLeafInTree = useStore((s) => s.splitLeafInTree);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Only offer panels that aren't already open in the tree — keeps the menu
  // honest about what a click will actually do.
  const tree = useStore((s) => s.layoutTreeByGroup[groupId]);
  const existingPaneIds = new Set(
    tree ? (function walk(n: LeafNode | import('./types').SplitNode): string[] {
      return n.type === 'leaf' ? n.panes.map((p) => p.id) : n.children.flatMap(walk);
    })(tree as LeafNode) : [],
  );
  const choices = panels.filter((p) => PANEL_KINDS.has(p.id as PaneKind) && !existingPaneIds.has(p.id));

  return (
    <Box ref={ref} position="relative">
      <OverlayIconButton
        title={dir === 'h' ? 'Split right' : 'Split down'}
        onClick={() => setOpen((o) => !o)}
        active={open}
      >
        {dir === 'h' ? (
          <Columns2 size={13} strokeWidth={1.8} />
        ) : (
          <Rows2 size={13} strokeWidth={1.8} />
        )}
      </OverlayIconButton>
      {open && (
        <Box
          position="absolute"
          top="100%"
          right="0"
          mt="4px"
          bg="#161b22"
          border="1px solid #30363d"
          borderRadius="6px"
          boxShadow="0 10px 30px rgba(0,0,0,0.5)"
          py="1"
          minW="160px"
          zIndex={100}
        >
          {choices.length === 0 ? (
            <Box px="3" py="1.5">
              <Text fontSize="11px" color="#7d8590">
                All panels are open.
              </Text>
            </Box>
          ) : (
            choices.map((p) => (
              <Box
                as="button"
                key={p.id}
                w="100%"
                textAlign="left"
                px="3"
                py="1.5"
                cursor="pointer"
                bg="transparent"
                border="none"
                color="#f0f6fc"
                fontSize="12px"
                _hover={{ bg: '#1f6feb' }}
                onClick={() => {
                  setOpen(false);
                  splitLeafInTree(
                    groupId,
                    leaf.id,
                    dir,
                    { id: p.id, kind: p.id as PaneKind, title: p.title },
                    true,
                  );
                }}
              >
                {p.title}
              </Box>
            ))
          )}
        </Box>
      )}
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
