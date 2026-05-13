import { useEffect, useRef, useState } from 'react';
import { Box, Flex, Text } from '@chakra-ui/react';
import { Sidebar } from './Sidebar';
import { Workspace } from './Workspace';
import { CommandPalette } from './CommandPalette';
import { DiffPanel } from './DiffPanel';
import { FileBrowserPanel } from './FileBrowserPanel';
import { useShortcuts } from './useShortcuts';
import { useStore } from './store';

const SIDEBAR_WIDTH = 220;
const DIFF_PANEL_WIDTH = 420;
const FILE_BROWSER_WIDTH = 420;
// When the workspace would have less than this many pixels next to the diff
// panel, force the panel into fullscreen instead of splitting the space.
const MIN_WORKSPACE_WIDTH = 480;

export function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const diffPanelOpen = useStore((s) => s.diffPanelOpen);
  const toggleDiffPanel = useStore((s) => s.toggleDiffPanel);
  const diffPanelFullscreen = useStore((s) => s.diffPanelFullscreen);
  const fileBrowserOpen = useStore((s) => s.fileBrowserOpen);
  const toggleFileBrowser = useStore((s) => s.toggleFileBrowser);
  const fileBrowserFullscreen = useStore((s) => s.fileBrowserFullscreen);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const contentW = windowWidth - (sidebarOpen ? SIDEBAR_WIDTH : 0);
  const activePanelBaseW = diffPanelOpen ? DIFF_PANEL_WIDTH
    : fileBrowserOpen ? FILE_BROWSER_WIDTH
    : 0;
  const panelOpen = diffPanelOpen || fileBrowserOpen;
  const forcedFullscreen = panelOpen && contentW - activePanelBaseW < MIN_WORKSPACE_WIDTH;
  const userFullscreen = diffPanelOpen ? diffPanelFullscreen
    : fileBrowserOpen ? fileBrowserFullscreen
    : false;
  const effectiveFullscreen = userFullscreen || forcedFullscreen;
  useShortcuts(() => setPaletteOpen(true));

  useEffect(() => {
    const s = useStore.getState();
    if (s.tabs.length === 0) s.newTab();
  }, []);

  return (
    <Flex direction="column" h="100vh" w="100vw" bg="#0d1117" overflow="hidden">
      <Flex
        h="36px"
        flexShrink={0}
        align="center"
        borderBottom="1px solid #21262d"
        position="relative"
        zIndex={50}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <Box w="76px" h="100%" flexShrink={0} />
        <Flex
          align="center"
          justify="center"
          h="100%"
          mr="8px"
          gap="4px"
          pt="2px"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <SidebarToggleButton open={sidebarOpen} onClick={toggleSidebar} />
          <AddWorkspaceSplitButton />
        </Flex>
        <Box flex="1" h="100%" />
        <Flex
          align="center"
          h="100%"
          pr="8px"
          pt="2px"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <FileBrowserToggleButton open={fileBrowserOpen} onClick={toggleFileBrowser} />
          <DiffToggleButton open={diffPanelOpen} onClick={toggleDiffPanel} />
        </Flex>
      </Flex>
      <Flex flex="1" minH="0" minW="0" overflow="hidden">
        <Box
          w={sidebarOpen ? `${SIDEBAR_WIDTH}px` : '0px'}
          flexShrink={0}
          borderRight={sidebarOpen ? '1px solid #21262d' : '1px solid transparent'}
          overflow="hidden"
          style={{
            transition: 'width 220ms cubic-bezier(0.22, 0.61, 0.36, 1), border-color 220ms ease',
          }}
        >
          <Box w={`${SIDEBAR_WIDTH}px`} h="100%">
            <Sidebar />
          </Box>
        </Box>
        <Box flex="1" position="relative" minW="0">
          {/* The workspace stays full-width when the diff panel is fullscreen so
              the terminal never re-layouts on max/min. Only opening/closing the
              right-side panel resizes it. */}
          <Box
            position="absolute"
            inset="0"
            pr={panelOpen && !forcedFullscreen ? `${activePanelBaseW}px` : '0px'}
            style={{
              transition: 'padding-right 240ms cubic-bezier(0.22, 0.61, 0.36, 1)',
            }}
          >
            <Workspace />
          </Box>
          <Box
            position="absolute"
            top="0"
            right="0"
            bottom="0"
            w={panelOpen
              ? (effectiveFullscreen ? '100%' : `${activePanelBaseW}px`)
              : '0px'}
            borderLeft={panelOpen ? '1px solid #21262d' : '1px solid transparent'}
            bg="#0d1117"
            overflow="hidden"
            style={{
              transition: 'width 240ms cubic-bezier(0.22, 0.61, 0.36, 1), border-color 240ms ease',
              willChange: 'width',
            }}
          >
            <Box w="100%" h="100%">
              {diffPanelOpen && <DiffPanel forcedFullscreen={forcedFullscreen} />}
              {fileBrowserOpen && (
                <FileBrowserPanel
                  forcedFullscreen={forcedFullscreen}
                  panelWidth={effectiveFullscreen ? contentW : activePanelBaseW}
                />
              )}
            </Box>
          </Box>
        </Box>
      </Flex>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </Flex>
  );
}

const TITLEBAR_ICON_COLOR = '#c9d1d9';

function TitlebarIconButton({
  title, onClick, active, children,
}: { title: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  const bg = active ? '#30363d' : hover ? '#21262d' : 'transparent';
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        background: bg,
        border: 'none',
        color: TITLEBAR_ICON_COLOR,
        cursor: 'pointer',
        padding: 0,
        margin: 0,
        height: '24px',
        width: '28px',
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 0,
        transition: 'background 120ms ease',
      }}
    >
      {children}
    </button>
  );
}

function AddWorkspaceSplitButton() {
  const newGroup = useStore((s) => s.newGroup);
  const setAutoEditCwdGroupId = useStore((s) => s.setAutoEditCwdGroupId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const quickAdd = () => { newGroup(undefined, '~'); setOpen(false); };

  const addWithFolder = async () => {
    setOpen(false);
    if (window.grove?.pickFolder) {
      const folder = await window.grove.pickFolder();
      if (folder) newGroup(undefined, folder);
      return;
    }
    const id = newGroup(undefined, '~');
    setAutoEditCwdGroupId(id);
  };

  return (
    <Box ref={ref} position="relative" display="inline-flex" alignItems="center">
      <TitlebarIconButton title="Add workspace" active={open} onClick={() => setOpen((o) => !o)}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M2 5.5a1 1 0 0 1 1-1h4l1.5 1.5h6a1 1 0 0 1 1 1V13.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M9 8.5v3.5M7.25 10.25h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </TitlebarIconButton>
      {open && (
        <Box
          position="absolute"
          top="100%"
          left="0"
          mt="6px"
          bg="#161b22"
          border="1px solid #30363d"
          borderRadius="6px"
          boxShadow="0 10px 30px rgba(0,0,0,0.5)"
          py="1"
          minW="240px"
          zIndex={100}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <MenuItem onClick={quickAdd} hint="Adds a workspace rooted at ~">Quick add</MenuItem>
          <MenuItem onClick={addWithFolder} hint="Create then immediately edit folder">Add with folder…</MenuItem>
        </Box>
      )}
    </Box>
  );
}

function MenuItem({ children, hint, onClick }: { children: React.ReactNode; hint?: string; onClick: () => void }) {
  return (
    <Box
      px="3"
      py="1.5"
      cursor="pointer"
      _hover={{ bg: '#1f6feb', '& .menu-hint': { color: '#cce0ff' } }}
      onClick={onClick}
    >
      <Text fontSize="12px" color="#f0f6fc">{children}</Text>
      {hint && <Text className="menu-hint" fontSize="12px" color="#7d8590">{hint}</Text>}
    </Box>
  );
}

function FileBrowserToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <TitlebarIconButton active={open} title={open ? 'Hide files' : 'Show files'} onClick={onClick}>
      <svg width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor">
        <path d="M2 3.5a1 1 0 0 1 1-1h4l1.5 1.5h7a1 1 0 0 1 1 1V12.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5z" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </TitlebarIconButton>
  );
}

function DiffToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <TitlebarIconButton active={open} title={open ? 'Hide diff' : 'Show diff'} onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor">
        <path d="M3 1h5l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M8 1v3h3" strokeWidth="1.2" />
        <path d="M5 7.5h4M7 5.5v4" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M5 11h4" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </TitlebarIconButton>
  );
}

function SidebarToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <TitlebarIconButton active={open} title={open ? 'Hide sidebar (⌘\\)' : 'Show sidebar (⌘\\)'} onClick={onClick}>
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
        <rect x="2" y="3" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <line x1="6.5" y1="3.5" x2="6.5" y2="14.5" stroke="currentColor" strokeWidth="1.3" />
        {open && <rect x="3" y="4" width="3" height="10" fill="currentColor" opacity="0.25" />}
      </svg>
    </TitlebarIconButton>
  );
}
