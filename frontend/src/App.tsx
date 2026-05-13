import { useEffect, useState } from 'react';
import { Box, Flex } from '@chakra-ui/react';
import { Sidebar } from './Sidebar';
import { Workspace } from './Workspace';
import { CommandPalette } from './CommandPalette';
import { useShortcuts } from './useShortcuts';
import { useStore } from './store';

export function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  useShortcuts(() => setPaletteOpen(true));

  useEffect(() => {
    const s = useStore.getState();
    if (s.tabs.length === 0) s.newTab();
  }, []);

  return (
    <Flex direction="column" h="100vh" w="100vw" bg="#0d1117">
      <Flex
        h="36px"
        flexShrink={0}
        align="center"
        borderBottom="1px solid #21262d"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <Box w="76px" h="100%" flexShrink={0} />
        <Box
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          mr="8px"
        >
          <SidebarToggleButton open={sidebarOpen} onClick={toggleSidebar} />
        </Box>
        <Box flex="1" h="100%" />
      </Flex>
      <Flex flex="1" minH="0">
        {sidebarOpen && (
          <Box w="220px" flexShrink={0} borderRight="1px solid #21262d" overflow="hidden">
            <Sidebar />
          </Box>
        )}
        <Box flex="1" position="relative" minW="0">
          <Workspace />
        </Box>
      </Flex>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </Flex>
  );
}

function SidebarToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={open ? 'Hide sidebar (⌘\\)' : 'Show sidebar (⌘\\)'}
      style={{
        background: 'transparent',
        border: 'none',
        color: open ? '#c9d1d9' : '#7d8590',
        cursor: 'pointer',
        padding: '4px 6px',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" strokeWidth="1.2" />
        {open && <rect x="2.5" y="3.5" width="3" height="9" fill="currentColor" opacity="0.25" />}
      </svg>
    </button>
  );
}
