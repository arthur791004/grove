import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Box, CloseButton, Dialog, Flex, IconButton, NativeSelect, Portal, Text } from '@chakra-ui/react';
import { RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Workspace } from './Workspace';
import { CommandPalette } from './CommandPalette';
import { useShortcuts } from './useShortcuts';
import { useStore, type Group } from './store';
import { shortPath } from './paths';

// Stable empty reference: returning a fresh `[]` from a selector would force a
// re-render every store tick because zustand uses reference equality.
const EMPTY_GROUPS: Group[] = [];

// Lazy-load the right-side panels: only one is ever open and they're each
// a chunk of code (DiffPanel pulls react-diff-view; FileBrowserPanel pulls
// prism-react-renderer + the icon set; BrowserPanel hosts the iframe).
// First open pays the import cost, then they're cached.
const DiffPanel = lazy(() => import('./DiffPanel').then((m) => ({ default: m.DiffPanel })));
const FileBrowserPanel = lazy(() => import('./FileBrowserPanel').then((m) => ({ default: m.FileBrowserPanel })));
const BrowserPanel = lazy(() => import('./BrowserPanel').then((m) => ({ default: m.BrowserPanel })));

const SIDEBAR_WIDTH = 220;
// Default right-side panel takes 40% of the content area, with a minimum
// width so it stays usable on small windows.
const PANEL_RATIO = 0.4;
const PANEL_MIN = 360;
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
  const browserPanelOpen = useStore((s) => s.browserPanelOpen);
  const toggleBrowserPanel = useStore((s) => s.toggleBrowserPanel);
  const browserPanelFullscreen = useStore((s) => s.browserPanelFullscreen);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const contentW = windowWidth - (sidebarOpen ? SIDEBAR_WIDTH : 0);
  const panelOpen = diffPanelOpen || fileBrowserOpen || browserPanelOpen;
  const activePanelBaseW = panelOpen ? Math.max(PANEL_MIN, Math.round(contentW * PANEL_RATIO)) : 0;
  const forcedFullscreen = panelOpen && contentW - activePanelBaseW < MIN_WORKSPACE_WIDTH;
  const userFullscreen = diffPanelOpen ? diffPanelFullscreen
    : fileBrowserOpen ? fileBrowserFullscreen
    : browserPanelOpen ? browserPanelFullscreen
    : false;
  const effectiveFullscreen = userFullscreen || forcedFullscreen;
  useShortcuts(() => setPaletteOpen(true));

  useEffect(() => {
    const s = useStore.getState();
    if (s.tabs.length === 0) s.newTab();
  }, []);

  // Apply font-family / font-size prefs to the document root so CSS variables
  // (and xterm via its own subscription) pick them up app-wide.
  const monoFontFamily = useStore((s) => s.monoFontFamily);
  const monoFontSize = useStore((s) => s.monoFontSize);
  useEffect(() => {
    const root = document.documentElement;
    if (monoFontFamily) root.style.setProperty('--grove-mono', monoFontFamily);
    else root.style.removeProperty('--grove-mono');
    root.style.setProperty('--grove-mono-size', `${monoFontSize}px`);
  }, [monoFontFamily, monoFontSize]);

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
          <BrowserToggleButton open={browserPanelOpen} onClick={toggleBrowserPanel} />
          <FileBrowserToggleButton open={fileBrowserOpen} onClick={toggleFileBrowser} />
          <DiffToggleButton open={diffPanelOpen} onClick={toggleDiffPanel} />
          <SettingsButton open={settingsOpen} onClick={() => setSettingsOpen((o) => !o)} />
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
              <Suspense fallback={<PanelLoading />}>
                {diffPanelOpen && <DiffPanel forcedFullscreen={forcedFullscreen} />}
                {fileBrowserOpen && (
                  <FileBrowserPanel
                    forcedFullscreen={forcedFullscreen}
                    panelWidth={effectiveFullscreen ? contentW : activePanelBaseW}
                  />
                )}
                {browserPanelOpen && (
                  <BrowserPanel
                    forcedFullscreen={forcedFullscreen}
                    panelWidth={effectiveFullscreen ? contentW : activePanelBaseW}
                  />
                )}
              </Suspense>
            </Box>
          </Box>
        </Box>
      </Flex>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Flex>
  );
}

function PanelLoading() {
  return (
    <Flex h="100%" w="100%" align="center" justify="center" bg="#010409" borderLeft="1px solid #21262d">
      <span className="grove-sq-loader">
        <span /><span /><span /><span />
      </span>
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
  const forkGroup = useStore((s) => s.forkGroup);
  const [open, setOpen] = useState(false);
  const [showForkPicker, setShowForkPicker] = useState(false);
  // groupId → is its cwd a git repo. Populated on demand when the fork
  // picker opens (or when the user clicks "Fork workspace…" with one group).
  const [forkable, setForkable] = useState<Record<string, boolean>>({});
  const ref = useRef<HTMLDivElement>(null);

  // Only subscribe to the heavy arrays while the picker is actually open —
  // otherwise this button re-renders on every tab title edit or pty tick.
  const groups = useStore((s) => (showForkPicker ? s.groups : EMPTY_GROUPS));
  const activeGroupId = useStore((s) => {
    if (!showForkPicker) return null;
    const t = s.tabs.find((t) => t.id === s.activeTabId);
    return t?.groupId ?? null;
  });

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

  const doFork = async (sourceId: string) => {
    setOpen(false);
    setShowForkPicker(false);
    const res = await forkGroup(sourceId);
    if ('error' in res) {
      // eslint-disable-next-line no-alert
      window.alert(`Fork failed: ${res.error}`);
    }
  };

  const forkClicked = async () => {
    if (!window.grove?.workspace) return;
    const all = useStore.getState().groups;
    // Resolve gitness for everything we don't already know, in parallel —
    // forks (forkedFromId set) are git-backed by construction so skip them.
    const checks = await Promise.all(all.map(async (g) => {
      if (g.forkedFromId) return [g.id, true] as const;
      const ok = await window.grove!.workspace.isGitRepo({ cwd: g.cwd });
      return [g.id, !!ok] as const;
    }));
    const map = Object.fromEntries(checks);
    setForkable(map);
    const eligible = all.filter((g) => map[g.id]);
    if (eligible.length === 0) {
      // eslint-disable-next-line no-alert
      window.alert('No git repositories among your workspaces. Fork is only available for workspaces inside a git repo.');
      setOpen(false);
      return;
    }
    if (eligible.length === 1) { doFork(eligible[0].id); return; }
    setShowForkPicker(true);
  };

  // Reset the picker sub-view when the dropdown closes so reopening starts
  // clean.
  useEffect(() => {
    if (!open) setShowForkPicker(false);
  }, [open]);

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
          {!showForkPicker && (
            <>
              <MenuItem onClick={quickAdd} hint="Adds a workspace rooted at ~">Quick add</MenuItem>
              <MenuItem onClick={addWithFolder} hint="Create then immediately edit folder">Add with folder…</MenuItem>
              <MenuItem onClick={forkClicked} hint="Clean parallel copy on a fresh branch">Fork workspace…</MenuItem>
            </>
          )}
          {showForkPicker && (
            <>
              <Box px="3" py="1.5">
                <Text fontSize="11px" color="#7d8590">Fork from…</Text>
              </Box>
              {groups.filter((g) => forkable[g.id]).map((g) => (
                <MenuItem
                  key={g.id}
                  onClick={() => doFork(g.id)}
                  hint={g.id === activeGroupId ? 'active' : g.cwd}
                >
                  {g.name}
                </MenuItem>
              ))}
            </>
          )}
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

function BrowserToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <TitlebarIconButton active={open} title={open ? 'Hide browser' : 'Show browser'} onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" strokeLinecap="round" />
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

function SettingsButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <TitlebarIconButton active={open} title="Settings" onClick={onClick}>
      <SlidersHorizontal size={18} strokeWidth={1.4} />
    </TitlebarIconButton>
  );
}

type OrphanBranch = { repoRoot: string; branch: string; worktreePath?: string };
type CleanupState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'list'; entries: OrphanBranch[] }
  | { status: 'empty' }
  | { status: 'done'; deleted: number; errors: Array<{ branch: string; message: string }> };

const MONO_FONT_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'System default', value: '' },
  { label: 'Hack', value: "'Hack', monospace" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', monospace" },
  { label: 'Fira Code', value: "'Fira Code', monospace" },
  { label: 'Cascadia Code', value: "'Cascadia Code', monospace" },
  { label: 'SF Mono', value: "'SF Mono', monospace" },
  { label: 'Menlo', value: 'Menlo, monospace' },
  { label: 'Monaco', value: 'Monaco, monospace' },
];

function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [cleanup, setCleanup] = useState<CleanupState>({ status: 'idle' });
  const monoFontFamily = useStore((s) => s.monoFontFamily);
  const monoFontSize = useStore((s) => s.monoFontSize);
  const setMonoFontFamily = useStore((s) => s.setMonoFontFamily);
  const setMonoFontSize = useStore((s) => s.setMonoFontSize);

  const refresh = async () => {
    if (!window.grove?.workspace) return;
    setCleanup({ status: 'loading' });
    const groups = useStore.getState().groups;
    // Treat any registry entry whose workspaceId isn't in `liveWorkspaceIds`
    // as orphaned, so the renderer enumerates everything it currently knows
    // about (sending non-fork ids is harmless).
    const liveWorkspaceIds = groups.map((g) => g.id);
    const cwds = groups.map((g) => g.cwd);
    try {
      const entries = await window.grove.workspace.listGroveBranches({ liveWorkspaceIds, cwds });
      setCleanup(entries.length === 0 ? { status: 'empty' } : { status: 'list', entries });
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(`Listing branches failed: ${err instanceof Error ? err.message : String(err)}`);
      setCleanup({ status: 'idle' });
    }
  };

  // Re-scan each time the dialog opens (don't keep stale lists after deletes
  // or closures from other surfaces).
  useEffect(() => { if (open) refresh(); }, [open]);

  const deleteAll = async () => {
    if (cleanup.status !== 'list' || !window.grove?.workspace) return;
    const entries = cleanup.entries;
    setCleanup({ status: 'loading' });
    const res = await window.grove.workspace.deleteBranches({ entries });
    setCleanup({ status: 'done', deleted: res.deleted, errors: res.errors });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop bg="rgba(0,0,0,0.5)" />
        <Dialog.Positioner>
          <Dialog.Content
            bg="#161b22"
            border="1px solid #30363d"
            borderRadius="8px"
            boxShadow="0 20px 60px rgba(0,0,0,0.6)"
            w="520px"
            h="560px"
            maxW="520px"
            display="flex"
            flexDirection="column"
          >
            <Dialog.Header px="4" py="3" borderBottom="1px solid #30363d" display="flex" alignItems="center" justifyContent="space-between">
              <Dialog.Title fontSize="14px" color="#f0f6fc" fontWeight="600">Settings</Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" color="#7d8590" />
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body flex="1" overflowY="auto" px="4" py="3">
              <Text fontSize="13px" color="#f0f6fc" fontWeight="600" mb="2">Appearance</Text>
              <Flex align="center" gap="3" mb="2">
                <Text fontSize="12px" color="#7d8590" w="80px" flexShrink={0}>Font family</Text>
                <Box flex="1">
                  <NativeSelect.Root size="sm">
                    <NativeSelect.Field
                      value={monoFontFamily}
                      onChange={(e) => setMonoFontFamily(e.target.value)}
                      bg="#0d1117"
                      color="#c9d1d9"
                      borderColor="#30363d"
                      fontSize="12px"
                    >
                      {MONO_FONT_OPTIONS.map((opt) => (
                        <option key={opt.label} value={opt.value}>{opt.label}</option>
                      ))}
                    </NativeSelect.Field>
                    <NativeSelect.Indicator color="#7d8590" />
                  </NativeSelect.Root>
                </Box>
              </Flex>
              <Flex align="center" gap="3" mb="4">
                <Text fontSize="12px" color="#7d8590" w="80px" flexShrink={0}>Font size</Text>
                <input
                  type="number"
                  min={8}
                  max={28}
                  value={monoFontSize}
                  onChange={(e) => setMonoFontSize(Number(e.target.value) || 13)}
                  style={{
                    width: 64, background: '#0d1117', color: '#c9d1d9',
                    border: '1px solid #30363d', borderRadius: 4,
                    padding: '4px 8px', fontSize: 12,
                    outline: 'none',
                  }}
                />
                <Text fontSize="11px" color="#7d8590">px</Text>
                <Box flex="1" />
                <Text
                  color="#c9d1d9"
                  style={{
                    fontFamily: monoFontFamily || "'Hack', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, Monaco, monospace",
                    fontSize: `${monoFontSize}px`,
                  }}
                >
                  The quick brown fox 0123
                </Text>
              </Flex>
              <Box borderTop="1px solid #30363d" my="3" />
              <Flex align="center" justify="space-between" mb="2">
                <Text fontSize="13px" color="#f0f6fc" fontWeight="600">Clean up Grove branches</Text>
                {(cleanup.status === 'list' || cleanup.status === 'done') && (
                  <IconButton
                    aria-label="Refresh"
                    onClick={refresh}
                    variant="outline"
                    size="xs"
                    borderColor="#30363d"
                    color="#c9d1d9"
                    _hover={{ bg: '#21262d' }}
                  >
                    <RefreshCw size={14} strokeWidth={1.6} />
                  </IconButton>
                )}
              </Flex>
              <Text fontSize="11px" color="#7d8590" mb="3">
                Orphan grove/* branches and worktree directories with no live workspace backing them.
              </Text>
              {cleanup.status === 'loading' && <Text fontSize="12px" color="#7d8590">Scanning…</Text>}
              {cleanup.status === 'empty' && <Text fontSize="12px" color="#c9d1d9">Nothing to clean up.</Text>}
              {cleanup.status === 'list' && (
                <>
                  <Box border="1px solid #30363d" borderRadius="6px" maxH="280px" overflowY="auto" mb="3">
                    {cleanup.entries.map((e) => (
                      <Flex key={`${e.repoRoot}\0${e.branch}`} px="3" py="2" borderBottom="1px solid #21262d" align="center" gap="2">
                        <Box flex="1" minW="0">
                          <Text fontSize="12px" color="#f0f6fc" fontFamily="var(--grove-mono)" truncate title={`${e.branch}\n${shortPath(e.repoRoot)}`}>
                            {e.branch}
                          </Text>
                          <Text fontSize="10px" color="#7d8590" truncate>{shortPath(e.repoRoot)}</Text>
                        </Box>
                        {e.worktreePath && (
                          <Text fontSize="10px" color="#d29922" fontFamily="var(--grove-mono)" flexShrink={0} title={shortPath(e.worktreePath)}>
                            orphan worktree
                          </Text>
                        )}
                      </Flex>
                    ))}
                  </Box>
                  <button
                    onClick={deleteAll}
                    style={{ background: 'transparent', border: '1px solid #30363d', color: '#c9d1d9', cursor: 'pointer', padding: '4px 12px', borderRadius: 4, fontSize: 12 }}
                  >
                    Delete {cleanup.entries.length} {cleanup.entries.length === 1 ? 'entry' : 'entries'}
                  </button>
                </>
              )}
              {cleanup.status === 'done' && (
                <>
                  <Text fontSize="12px" color="#c9d1d9">Deleted {cleanup.deleted} branch{cleanup.deleted === 1 ? '' : 'es'}.</Text>
                  {cleanup.errors.length > 0 && (
                    <Box mt="2">
                      <Text fontSize="11px" color="#f85149" mb="1">{cleanup.errors.length} failed:</Text>
                      {cleanup.errors.map((err) => (
                        <Text key={err.branch} fontSize="10px" color="#7d8590" fontFamily="var(--grove-mono)" mb="0.5">
                          {err.branch} — {err.message}
                        </Text>
                      ))}
                    </Box>
                  )}
                </>
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
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
