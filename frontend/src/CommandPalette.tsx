import { useEffect, useMemo, useState } from 'react';
import { Box, Input, Text } from '@chakra-ui/react';
import Fuse from 'fuse.js';
import { useStore } from './store';
import { COLOR_HEX } from './colors';

interface Props { open: boolean; onClose: () => void }

export function CommandPalette({ open, onClose }: Props) {
  const tabs = useStore((s) => s.tabs);
  const groups = useStore((s) => s.groups);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (open) { setQuery(''); setSelected(0); }
  }, [open]);

  const items = useMemo(() => {
    return tabs.map((t) => {
      const g = groups.find((x) => x.id === t.groupId);
      return { id: t.id, title: t.title, group: g?.name ?? '', color: t.color };
    });
  }, [tabs, groups]);

  const fuse = useMemo(() => new Fuse(items, { keys: ['title', 'group'], threshold: 0.4 }), [items]);
  const results = query ? fuse.search(query).map((r) => r.item) : items;

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { setSelected((s) => Math.min(s + 1, results.length - 1)); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { setSelected((s) => Math.max(s - 1, 0)); e.preventDefault(); return; }
    if (e.key === 'Enter') {
      const pick = results[selected];
      if (pick) { setActiveTab(pick.id); onClose(); }
    }
  }

  if (!open) return null;

  return (
    <Box
      position="fixed"
      inset="0"
      bg="rgba(0,0,0,0.4)"
      zIndex={1000}
      display="flex"
      justifyContent="center"
      pt="80px"
      onClick={onClose}
    >
      <Box
        w="520px"
        bg="#161b22"
        border="1px solid #30363d"
        borderRadius="8px"
        boxShadow="0 20px 60px rgba(0,0,0,0.6)"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <Input
          autoFocus
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
          placeholder="Search tabs…"
          variant="flushed"
          color="#c9d1d9"
          borderColor="#30363d"
          px="3"
          py="3"
        />
        <Box maxH="320px" overflowY="auto">
          {results.length === 0 && (
            <Text px="3" py="2" color="#7d8590" fontSize="sm">No tabs.</Text>
          )}
          {results.map((r, i) => (
            <Box
              key={r.id}
              px="3"
              py="2"
              bg={i === selected ? '#1f6feb33' : 'transparent'}
              cursor="pointer"
              onMouseEnter={() => setSelected(i)}
              onClick={() => { setActiveTab(r.id); onClose(); }}
              display="flex"
              alignItems="center"
              gap="2"
            >
              <Box w="8px" h="8px" borderRadius="4px" bg={COLOR_HEX[r.color]} />
              <Text color="#c9d1d9" fontSize="sm" flex="1">{r.title}</Text>
              <Text color="#7d8590" fontSize="xs">{r.group}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
