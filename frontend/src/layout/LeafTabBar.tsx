// Browser-style TabBar rendered above each leaf when `tabPosition === 'top'`.
// Lists the leaf's panes as clickable tabs; trailing `+ ▾` opens a kind
// picker so the user can add a Terminal / Claude / Diff / Files / Browser as
// a new pane in this leaf.

import { useEffect, useRef, useState } from 'react';
import { Box, Flex, Text } from '@chakra-ui/react';
import { ChevronDown, FileDiff, FolderTree, Globe, Plus, Terminal, Sparkles, X } from 'lucide-react';
import { useStore } from '../store';
import type { LeafNode, Pane, PaneKind } from './types';

function PaneIcon({ kind, size = 12 }: { kind: PaneKind; size?: number }) {
  if (kind === 'shell') return <Terminal size={size} strokeWidth={1.6} />;
  if (kind === 'claude') return <Sparkles size={size} strokeWidth={1.6} />;
  if (kind === 'diff') return <FileDiff size={size} strokeWidth={1.6} />;
  if (kind === 'files') return <FolderTree size={size} strokeWidth={1.6} />;
  if (kind === 'browser') return <Globe size={size} strokeWidth={1.6} />;
  return null;
}

export function LeafTabBar({ leaf, groupId }: { leaf: LeafNode; groupId: string }) {
  return (
    <Flex
      h="30px"
      flexShrink={0}
      align="center"
      bg="#0d1117"
      borderBottom="1px solid #21262d"
      px="1"
      gap="1"
      overflowX="auto"
    >
      {leaf.panes.map((p) => (
        <TabChip key={p.id} pane={p} leaf={leaf} groupId={groupId} />
      ))}
      <NewTabButton leaf={leaf} groupId={groupId} />
    </Flex>
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
  return (
    <Flex
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
            // closeTab handles backend session DELETE + tree cleanup + active
            // tab fallback; just delegating avoids drift between the legacy
            // tabs[] mirror and the tree.
            closeTab(pane.id);
          } else {
            removePaneFromTree(groupId, pane.id);
            if (activePanelId === pane.id) useStore.setState({ activePanelId: null });
          }
        }}
      >
        <X size={10} strokeWidth={2} />
      </Box>
    </Flex>
  );
}

const ALL_KINDS: Array<{ kind: PaneKind; label: string }> = [
  { kind: 'shell', label: 'Terminal' },
  { kind: 'claude', label: 'Claude' },
  { kind: 'diff', label: 'Diff' },
  { kind: 'files', label: 'Files' },
  { kind: 'browser', label: 'Browser' },
];

function NewTabButton({ leaf, groupId }: { leaf: LeafNode; groupId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const defaultKind = useStore((s) => s.newTabMode);
  const addPaneToLeafInTree = useStore((s) => s.addPaneToLeafInTree);
  const newTab = useStore((s) => s.newTab);
  const setActivePaneInTree = useStore((s) => s.setActivePaneInTree);
  const treeForGroup = useStore((s) => s.layoutTreeByGroup[groupId]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const addPane = (kind: PaneKind) => {
    setOpen(false);
    if (kind === 'shell' || kind === 'claude') {
      // newTab handles backend session bootstrap + pty + tree push. It
      // currently adds to the workspace leaf (first leaf without panel
      // panes), not necessarily this leaf — slice 5 will let us target.
      newTab(groupId, undefined, { mode: kind });
      return;
    }
    // Panel kinds: add as a new tab in this same leaf (browser-style). If
    // that panel is already open in another leaf of this workspace, focus it
    // there instead of double-mounting.
    const titles: Record<string, string> = {
      diff: 'Diff',
      files: 'Files',
      browser: 'Browser',
    };
    const existsElsewhere =
      treeForGroup &&
      (function walk(n: import('./types').LayoutNode): boolean {
        return n.type === 'leaf'
          ? n.panes.some((p) => p.id === kind)
          : n.children.some(walk);
      })(treeForGroup);
    if (existsElsewhere) {
      setActivePaneInTree(groupId, kind);
      useStore.setState({ activePanelId: kind });
      return;
    }
    const pane: Pane = { id: kind, kind, title: titles[kind] ?? kind };
    addPaneToLeafInTree(groupId, leaf.id, pane);
    setActivePaneInTree(groupId, kind);
    useStore.setState({ activePanelId: kind });
  };

  return (
    <Flex ref={ref} position="relative" align="center" ml="auto" gap="0">
      <Flex
        as="button"
        align="center"
        justify="center"
        w="22px"
        h="22px"
        borderRadius="3px"
        bg="transparent"
        border="none"
        color="#7d8590"
        cursor="pointer"
        _hover={{ bg: '#21262d', color: '#f0f6fc' }}
        onClick={() => addPane(defaultKind)}
        title={`New ${defaultKind} tab`}
      >
        <Plus size={13} strokeWidth={2} />
      </Flex>
      <Flex
        as="button"
        align="center"
        justify="center"
        w="16px"
        h="22px"
        borderRadius="3px"
        bg={open ? '#21262d' : 'transparent'}
        border="none"
        color="#7d8590"
        cursor="pointer"
        _hover={{ bg: '#21262d', color: '#f0f6fc' }}
        onClick={() => setOpen((o) => !o)}
        title="New tab type…"
      >
        <ChevronDown size={11} strokeWidth={2} />
      </Flex>
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
          zIndex={120}
        >
          {ALL_KINDS.map(({ kind, label }) => (
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
              onClick={() => addPane(kind)}
            >
              <Box w="14px" display="flex" alignItems="center">
                <PaneIcon kind={kind} size={13} />
              </Box>
              {label}
            </Flex>
          ))}
        </Box>
      )}
    </Flex>
  );
}
