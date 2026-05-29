import { useEffect, useRef, useState } from 'react';
import {
  Box,
  CloseButton,
  Dialog,
  Drawer,
  Flex,
  Grid,
  IconButton,
  NativeSelect,
  Portal,
  SegmentGroup,
  Switch,
  Text,
} from '@chakra-ui/react';
import { Bot, RefreshCw, SlidersHorizontal } from 'lucide-react';
import QRCode from 'qrcode';
import { useIsMobile } from './useViewport';
import { MobileHeader } from './MobileHeader';
import { IS_ELECTRON } from './env';
import { Sidebar } from './Sidebar';
import { AgentsView } from './AgentsView';
import { LayoutHost } from './layout/LayoutHost';
import { useHideBrowserOverlay } from './useHideBrowserOverlay';
import { CommandPalette } from './CommandPalette';
import { ReconnectBanner } from './ReconnectBanner';
import { SessionChoiceDialog } from './SessionChoiceDialog';
import { sendSessionInput } from './api';
import { useShortcuts } from './useShortcuts';
import { useStore, type Group, type NewTabMode, type TabPosition } from './store';
import { shortPath } from './paths';
import './extensions/builtins';
import { usePanels } from './extensions/registry';

// Stable empty reference: returning a fresh `[]` from a selector would force a
// re-render every store tick because zustand uses reference equality.
const EMPTY_GROUPS: Group[] = [];

const SIDEBAR_WIDTH = 220;

export function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const agentsViewOpen = useStore((s) => s.agentsViewOpen);
  const toggleAgentsView = useStore((s) => s.toggleAgentsView);
  const blockedAgentCount = useStore(
    (s) => Object.values(s.agentStates).filter((x) => x === 'blocked').length,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Phone-sized viewport: the layout drops the sidebar and right panel in
  // favour of a slide-in drawer and a fullscreen panel overlay.
  const isMobile = useIsMobile();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const activeTabId = useStore((s) => s.activeTabId);
  // Picking a workspace in the drawer switches the active tab — close the
  // drawer whenever that (or any other tab switch) happens.
  useEffect(() => setMobileDrawerOpen(false), [activeTabId]);
  const activeGroupName = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return (tab && s.groups.find((g) => g.id === tab.groupId)?.name) || 'Grove';
  });

  // Registry-driven panel state. activePanelId is the registry id (or null);
  // the active panel is looked up from the registry.
  const panels = usePanels();
  const activePanelId = useStore((s) => s.activePanelId);
  const togglePanel = useStore((s) => s.togglePanel);
  // The embedded browser panel is Electron-only (WebContentsView) — in any
  // browser build it's neither rendered nor offered. Titlebar panel toggles
  // were removed in both modes: opening Diff/Files/Browser now goes through
  // the workspace right-click "New tab" menu (sidebar) or the TabBar's `+`
  // and right-click (top), keeping the titlebar uniform.
  const titlebarPanels: typeof panels = [];

  const contentW = windowWidth - (!isMobile && sidebarOpen ? SIDEBAR_WIDTH : 0);
  useShortcuts(() => setPaletteOpen(true));

  useEffect(() => {
    const s = useStore.getState();
    if (s.tabs.length === 0) s.newTab();
  }, []);

  // Route clicks on a blocked-Claude notification: an action button sends the
  // chosen answer straight to that tab's pty; the body just opens the tab.
  useEffect(() => {
    return window.grove?.onNotificationRespond?.((r) => {
      const s = useStore.getState();
      if (r.send) {
        // Drop a stale answer if the tab is no longer waiting on a prompt.
        if (s.agentStates[r.tabId] === 'blocked') sendSessionInput(r.tabId, r.send + '\r');
      } else {
        s.setActiveTab(r.tabId);
      }
    });
  }, []);

  // Type a queued first message into a newly-created Claude tab once the
  // backend agent-state ticker confirms the TUI is up. Lives at App level
  // (not inside AgentsView) so the message still gets delivered if the user
  // toggles the Agents View off while claude is still booting.
  //
  // Trigger condition: state hits 'blocked' — that's the marker for "prompt
  // shown, accepting input". 'working' would mean claude is mid-turn and
  // typing into it would be ignored or appended to the in-flight prompt.
  useEffect(() => {
    return useStore.subscribe((s, prev) => {
      if (s.agentStates === prev.agentStates && s.pendingFirstMessages === prev.pendingFirstMessages) {
        return;
      }
      for (const tabId of Object.keys(s.pendingFirstMessages)) {
        if (s.agentStates[tabId] !== 'blocked') continue;
        const msg = s.consumePendingFirstMessage(tabId);
        if (msg) void sendSessionInput(tabId, msg + '\r');
      }
    });
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
    <Flex
      direction="column"
      h="100dvh"
      w="100vw"
      bg="#0d1117"
      overflow="hidden"
      style={
        isMobile
          ? {
              // Clear the notch at the top; clear the keyboard + home
              // indicator at the bottom so the composer is never covered.
              paddingTop: 'env(safe-area-inset-top, 0px)',
              paddingBottom:
                'calc(var(--keyboard-height, 0px) + env(safe-area-inset-bottom, 0px))',
              boxSizing: 'border-box',
            }
          : undefined
      }
    >
      {isMobile ? (
        <MobileHeader
          workspaceName={activeGroupName}
          panels={titlebarPanels}
          activePanelId={activePanelId}
          onTogglePanel={togglePanel}
          onOpenDrawer={() => setMobileDrawerOpen((o) => !o)}
          settingsOpen={settingsOpen}
          onToggleSettings={() => setSettingsOpen((o) => !o)}
          isElectron={IS_ELECTRON}
        />
      ) : (
        <Flex
          h="36px"
          flexShrink={0}
          align="center"
          borderBottom="1px solid #21262d"
          bg="#0d1117"
          position="relative"
          zIndex={50}
          style={IS_ELECTRON ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
        >
          {/* macOS traffic-light spacer — only meaningful inside Electron. */}
          <Box w={IS_ELECTRON ? '76px' : '8px'} h="100%" flexShrink={0} />
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
            {/* Adding a workspace needs a native folder picker — Electron only. */}
            {IS_ELECTRON && <AddWorkspaceSplitButton />}
            <AgentsToggleButton
              active={agentsViewOpen}
              blocked={blockedAgentCount}
              onClick={toggleAgentsView}
            />
          </Flex>
          <Box flex="1" h="100%" />
          <Flex
            align="center"
            h="100%"
            pr="8px"
            pt="2px"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {titlebarPanels.map((p) => (
              <TitlebarIconButton
                key={p.id}
                active={activePanelId === p.id}
                title={
                  activePanelId === p.id
                    ? `Hide ${p.title.toLowerCase()}`
                    : `Show ${p.title.toLowerCase()}`
                }
                onClick={() => togglePanel(p.id)}
              >
                {p.icon}
              </TitlebarIconButton>
            ))}
            <SettingsButton open={settingsOpen} onClick={() => setSettingsOpen((o) => !o)} />
          </Flex>
        </Flex>
      )}
      <Flex flex="1" minH="0" minW="0" overflow="hidden">
        {!isMobile && (
          <Box
            w={sidebarOpen ? `${SIDEBAR_WIDTH}px` : '0px'}
            flexShrink={0}
            borderRight={sidebarOpen ? '1px solid #21262d' : '1px solid transparent'}
            overflow="hidden"
            style={{
              transition:
                'width 220ms cubic-bezier(0.22, 0.61, 0.36, 1), border-color 220ms ease',
            }}
          >
            <Box w={`${SIDEBAR_WIDTH}px`} h="100%">
              <Sidebar />
            </Box>
          </Box>
        )}
        <Box flex="1" position="relative" minW="0" style={{ isolation: 'isolate' }}>
          {/* Keep the layout host mounted even when the Agents View is
              showing, so existing TerminalViews stay alive and new agent
              tabs can bootstrap (spawn claude, fire agentStates) in the
              background while the user is on the Agents View. */}
          <Box w="100%" h="100%" display={agentsViewOpen ? 'none' : 'block'}>
            <LayoutContent contentW={contentW} />
          </Box>
          {agentsViewOpen && <AgentsView />}
        </Box>
      </Flex>
      {/* Workspace drawer — Chakra Drawer handles the slide animation,
          backdrop, focus trap, scroll lock, ESC-to-close and ARIA wiring. */}
      {isMobile && (
        <Drawer.Root
          open={mobileDrawerOpen}
          onOpenChange={(e) => setMobileDrawerOpen(e.open)}
          placement="start"
        >
          <Portal>
            <Drawer.Backdrop bg="rgba(1,4,9,0.6)" />
            <Drawer.Positioner>
              <Drawer.Content
                bg="#0d1117"
                w="80vw"
                maxW="300px"
                p="0"
                borderRight="1px solid #21262d"
                style={{
                  paddingTop: 'env(safe-area-inset-top, 0px)',
                  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
                }}
              >
                <Sidebar />
              </Drawer.Content>
            </Drawer.Positioner>
          </Portal>
        </Drawer.Root>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SessionChoiceDialog />
      <ReconnectBanner />
    </Flex>
  );
}

function LayoutContent({ contentW }: { contentW: number }) {
  // The active group's tree owns the layout. Resolution order:
  //   1. If a panel is currently focused (`activePanelId` set), find whose
  //      tree contains it — that workspace becomes active. Lets the user
  //      click Diff/Files/Browser in a *different* workspace's sidebar and
  //      jump to that workspace without a separate switch click.
  //   2. Otherwise use the active tab's group.
  //   3. Fall back to the first workspace.
  const activeGroupId = useStore((s) => {
    if (s.activePanelId) {
      for (const [gid, tree] of Object.entries(s.layoutTreeByGroup)) {
        const found = (function walk(n: import('./layout/types').LayoutNode): boolean {
          return n.type === 'leaf'
            ? n.panes.some((p) => p.id === s.activePanelId)
            : n.children.some(walk);
        })(tree);
        if (found) return gid;
      }
    }
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.groupId ?? s.groupOrder[0] ?? null;
  });
  const tree = useStore((s) => (activeGroupId ? s.layoutTreeByGroup[activeGroupId] : null));
  const resizeLayoutSplit = useStore((s) => s.resizeLayoutSplit);

  // The user-visible "tabs" are the top-level entries under root. Main
  // screen only renders the ACTIVE entry — never multiple top-level entries
  // side-by-side. Splits are sub-trees within an entry and *do* render
  // side-by-side, because the user explicitly asked to see those panes
  // simultaneously.
  const focusedId = useStore((s) => s.activePanelId ?? s.activeTabId);
  if (!tree || (tree.type === 'leaf' && tree.panes.length === 0)) {
    return (
      <Flex h="100%" w="100%" align="center" justify="center" bg="#010409">
        <Text color="#7d8590" fontSize="sm">
          No tabs. Press ⌘T to create one.
        </Text>
      </Flex>
    );
  }
  // Find the top-level entry that owns the focused pane; fall back to the
  // first entry if nothing matches.
  let renderedTree = tree;
  if (tree.type === 'split' && focusedId) {
    const containing = tree.children.find((c) => nodeContains(c, focusedId));
    if (containing) renderedTree = containing;
    else renderedTree = tree.children[0];
  } else if (tree.type === 'split') {
    renderedTree = tree.children[0];
  }

  return (
    <LayoutHost
      tree={renderedTree}
      groupId={activeGroupId ?? ''}
      forcedFullscreen={false}
      panelWidth={contentW}
      onSplitResize={(splitId, sizes) => {
        if (activeGroupId) resizeLayoutSplit(activeGroupId, splitId, sizes);
      }}
    />
  );
}

function nodeContains(node: import('./layout/types').LayoutNode, paneId: string): boolean {
  return node.type === 'leaf'
    ? node.panes.some((p) => p.id === paneId)
    : node.children.some((c) => nodeContains(c, paneId));
}

const TITLEBAR_ICON_COLOR = '#c9d1d9';

function TitlebarIconButton({
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

function AgentsToggleButton({
  active,
  blocked,
  onClick,
}: {
  active: boolean;
  blocked: number;
  onClick: () => void;
}) {
  return (
    <Box position="relative" display="inline-flex">
      <TitlebarIconButton
        active={active}
        title={active ? 'Hide agents view' : 'Show agents view'}
        onClick={onClick}
      >
        <Bot size={16} strokeWidth={1.6} />
      </TitlebarIconButton>
      {blocked > 0 && (
        <Box
          position="absolute"
          top="0"
          right="0"
          minW="14px"
          h="14px"
          px="1"
          borderRadius="999px"
          bg="#f85149"
          color="#fff"
          fontSize="9px"
          fontWeight={700}
          display="flex"
          alignItems="center"
          justifyContent="center"
          style={{ pointerEvents: 'none', boxShadow: '0 0 0 1.5px #0d1117' }}
        >
          {blocked}
        </Box>
      )}
    </Box>
  );
}

function AddWorkspaceSplitButton() {
  const newGroup = useStore((s) => s.newGroup);
  const setAutoEditCwdGroupId = useStore((s) => s.setAutoEditCwdGroupId);
  const forkGroup = useStore((s) => s.forkGroup);
  const [open, setOpen] = useState(false);
  useHideBrowserOverlay(open);
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

  const quickAdd = () => {
    newGroup(undefined, '~');
    setOpen(false);
  };

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
    const checks = await Promise.all(
      all.map(async (g) => {
        if (g.forkedFromId) return [g.id, true] as const;
        const ok = await window.grove!.workspace.isGitRepo({ cwd: g.cwd });
        return [g.id, !!ok] as const;
      }),
    );
    const map = Object.fromEntries(checks);
    setForkable(map);
    const eligible = all.filter((g) => map[g.id]);
    if (eligible.length === 0) {
      // eslint-disable-next-line no-alert
      window.alert(
        'No git repositories among your workspaces. Fork is only available for workspaces inside a git repo.',
      );
      setOpen(false);
      return;
    }
    if (eligible.length === 1) {
      doFork(eligible[0].id);
      return;
    }
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
          <path
            d="M2 5.5a1 1 0 0 1 1-1h4l1.5 1.5h6a1 1 0 0 1 1 1V13.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path
            d="M9 8.5v3.5M7.25 10.25h3.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
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
              <MenuItem onClick={quickAdd} hint="Adds a workspace rooted at ~">
                Quick add
              </MenuItem>
              <MenuItem onClick={addWithFolder} hint="Create then immediately edit folder">
                Add with folder…
              </MenuItem>
              <MenuItem onClick={forkClicked} hint="Clean parallel copy on a fresh branch">
                Fork workspace…
              </MenuItem>
            </>
          )}
          {showForkPicker && (
            <>
              <Box px="3" py="1.5">
                <Text fontSize="11px" color="#7d8590">
                  Fork from…
                </Text>
              </Box>
              {groups
                .filter((g) => forkable[g.id])
                .map((g) => (
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

function MenuItem({
  children,
  hint,
  onClick,
}: {
  children: React.ReactNode;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <Box
      px="3"
      py="1.5"
      cursor="pointer"
      _hover={{ bg: '#1f6feb', '& .menu-hint': { color: '#cce0ff' } }}
      onClick={onClick}
    >
      <Text fontSize="12px" color="#f0f6fc">
        {children}
      </Text>
      {hint && (
        <Text className="menu-hint" fontSize="12px" color="#7d8590">
          {hint}
        </Text>
      )}
    </Box>
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

// Remote access: lets a phone reach this Grove over Tailscale. The toggle and
// status come from the Electron main process (window.grove.remote) — flipping
// it restarts the backend daemon. See electron/src/remote.ts.
function RemoteAccessSection() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.grove?.remote?.status().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const url = status?.enabled ? status.url : null;
  useEffect(() => {
    if (!url) {
      setQr(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(url, { width: 176, margin: 1 })
      .then((d) => !cancelled && setQr(d))
      .catch(() => !cancelled && setQr(null));
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Remote access is a desktop-only control: the phone-side UI (served by the
  // daemon) has no Electron IPC bridge, so just explain where to find it.
  if (!window.grove?.remote) {
    return (
      <Text fontSize="12px" color="#7d8590">
        Remote access can only be managed from the Grove desktop app.
      </Text>
    );
  }

  const onToggle = async (next: boolean) => {
    // Toggling rebinds the daemon, which can only happen by restarting it —
    // and that kills every running PTY. Make sure the user expects it.
    const ok = window.confirm(
      `${next ? 'Enable' : 'Disable'} remote access?\n\n` +
        'This restarts the Grove backend, which closes every running terminal session.',
    );
    if (!ok) return;
    setBusy(true);
    try {
      setStatus(await window.grove!.remote.setEnabled(next));
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = () => {
    if (!status?.url) return;
    void navigator.clipboard?.writeText(status.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <>
      <Flex align="center" justify="space-between" mb="1">
        <Text fontSize="13px" color="#f0f6fc">
          Allow connections from your phone
        </Text>
        <Switch.Root
          colorPalette="green"
          checked={status?.enabled ?? false}
          disabled={busy || !status}
          onCheckedChange={(e) => onToggle(e.checked)}
        >
          <Switch.HiddenInput />
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Root>
      </Flex>
      <Text fontSize="11px" color="#7d8590" mb="2">
        Reach this Grove from your phone over Tailscale. Connections are limited to your
        tailnet and require the one-time access token below.
      </Text>
      {busy && (
        <Text fontSize="12px" color="#7d8590">
          Restarting backend…
        </Text>
      )}
      {!busy && status?.enabled && status.url && (
        <Flex gap="3" align="flex-start">
          {qr && (
            <img
              src={qr}
              width={128}
              height={128}
              alt="Connect QR code"
              style={{ borderRadius: 6, background: '#fff', padding: 4, flexShrink: 0 }}
            />
          )}
          <Box flex="1" minW="0">
            <Text fontSize="11px" color="#7d8590" mb="1">
              Scan the code, or open this URL on your phone:
            </Text>
            <Box
              fontFamily="var(--grove-mono)"
              fontSize="11px"
              color="#c9d1d9"
              bg="#0d1117"
              border="1px solid #30363d"
              borderRadius="4px"
              px="2"
              py="1.5"
              mb="2"
              wordBreak="break-all"
            >
              {status.url}
            </Box>
            <button
              onClick={copyUrl}
              style={{
                background: 'transparent',
                border: '1px solid #30363d',
                color: '#c9d1d9',
                cursor: 'pointer',
                padding: '4px 12px',
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              {copied ? 'Copied' : 'Copy URL'}
            </button>
          </Box>
        </Flex>
      )}
      {!busy && status?.enabled && !status.url && (
        <Text fontSize="12px" color="#d29922">
          Tailscale isn't running, so there's no address to connect to yet. Remote mode is on
          — start Tailscale and reopen Settings to get the connect URL.
        </Text>
      )}
    </>
  );
}

function AppearanceSection() {
  const monoFontFamily = useStore((s) => s.monoFontFamily);
  const monoFontSize = useStore((s) => s.monoFontSize);
  const setMonoFontFamily = useStore((s) => s.setMonoFontFamily);
  const setMonoFontSize = useStore((s) => s.setMonoFontSize);
  return (
    <>
      <Flex align="center" gap="3" mb="3">
        <Text fontSize="12px" color="#7d8590" w="80px" flexShrink={0}>
          Font family
        </Text>
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
                <option key={opt.label} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator color="#7d8590" />
          </NativeSelect.Root>
        </Box>
      </Flex>
      <Flex align="center" gap="3">
        <Text fontSize="12px" color="#7d8590" w="80px" flexShrink={0}>
          Font size
        </Text>
        <input
          type="number"
          min={8}
          max={28}
          value={monoFontSize}
          onChange={(e) => setMonoFontSize(Number(e.target.value) || 13)}
          style={{
            width: 64,
            background: '#0d1117',
            color: '#c9d1d9',
            border: '1px solid #30363d',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <Text fontSize="11px" color="#7d8590">
          px
        </Text>
        <Box flex="1" />
        <Text
          color="#c9d1d9"
          style={{
            fontFamily:
              monoFontFamily ||
              "'Hack', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, Monaco, monospace",
            fontSize: `${monoFontSize}px`,
          }}
        >
          The quick brown fox 0123
        </Text>
      </Flex>
    </>
  );
}

function TabsSection() {
  const newTabMode = useStore((s) => s.newTabMode);
  const setNewTabMode = useStore((s) => s.setNewTabMode);
  const tabPosition = useStore((s) => s.tabPosition);
  const setTabPosition = useStore((s) => s.setTabPosition);
  return (
    <Grid templateColumns="100px 1fr" gap="3" alignItems="center">
      <Text fontSize="12px" color="#7d8590">
        New tab opens as
      </Text>
      <Box>
        <SegmentGroup.Root
          size="xs"
          value={newTabMode}
          onValueChange={(e) => {
            if (e.value) setNewTabMode(e.value as NewTabMode);
          }}
        >
          <SegmentGroup.Indicator />
          <SegmentGroup.Items
            items={[
              { value: 'shell', label: 'Shell' },
              { value: 'claude', label: 'Claude' },
            ]}
          />
        </SegmentGroup.Root>
        <Text fontSize="11px" color="#7d8590" mt="1.5">
          Claude mode auto-runs <code>claude</code> in new tabs. Requires Claude Code installed
          and authenticated.
        </Text>
      </Box>
      <Text fontSize="12px" color="#7d8590">
        Tab position
      </Text>
      <Box>
        <SegmentGroup.Root
          size="xs"
          value={tabPosition}
          onValueChange={(e) => {
            if (e.value) setTabPosition(e.value as TabPosition);
          }}
        >
          <SegmentGroup.Indicator />
          <SegmentGroup.Items
            items={[
              { value: 'sidebar', label: 'Sidebar' },
              { value: 'top', label: 'Top' },
            ]}
          />
        </SegmentGroup.Root>
        <Text fontSize="11px" color="#7d8590" mt="1.5">
          Sidebar: tabs listed under each workspace (today's layout). Top: tabs render as a
          strip above each pane, browser-style.
        </Text>
      </Box>
    </Grid>
  );
}

// In-app cheatsheet for every keyboard shortcut Grove registers in
// useShortcuts. Keep this list in sync with the bindings there — there's no
// runtime introspection; the source of truth is still the handler.
const SHORTCUT_GROUPS: Array<{ title: string; rows: Array<{ keys: string[]; label: string }> }> = [
  {
    title: 'Tabs & panes',
    rows: [
      { keys: ['⌘', 'T'], label: 'New tab in the focused pane' },
      { keys: ['⌘', 'W'], label: 'Close focused pane' },
      { keys: ['⌘', 'D'], label: 'Split right with another pane of the same kind' },
      { keys: ['⌘', '⇧', 'D'], label: 'Split down with another pane of the same kind' },
    ],
  },
  {
    title: 'Navigation',
    rows: [
      { keys: ['⌘', '1'], label: '… ⌘9 — jump to top-level tab N in this workspace' },
      { keys: ['⌘', '⇧', '['], label: 'Previous top-level tab' },
      { keys: ['⌘', '⇧', ']'], label: 'Next top-level tab' },
      { keys: ['⌘', '⌥', '←'], label: 'Focus pane to the left within a split' },
      { keys: ['⌘', '⌥', '→'], label: 'Focus pane to the right within a split' },
      { keys: ['⌘', '⌥', '↑'], label: 'Focus pane above within a split' },
      { keys: ['⌘', '⌥', '↓'], label: 'Focus pane below within a split' },
    ],
  },
  {
    title: 'App',
    rows: [
      { keys: ['⌘', 'P'], label: 'Open command palette / fuzzy tab search' },
      { keys: ['⌘', 'K'], label: 'Open command palette (alias)' },
      { keys: ['⌘', '\\'], label: 'Toggle sidebar' },
      { keys: ['⌘', '⇧', '1'], label: '… ⌘⇧9 — fire pin N from the pin bar' },
    ],
  },
];

function ShortcutsSection() {
  return (
    <Flex direction="column" gap="4">
      <Text fontSize="11px" color="#7d8590">
        On macOS use ⌘; on Windows / Linux use Ctrl. Shortcuts target the focused pane and the
        active workspace.
      </Text>
      {SHORTCUT_GROUPS.map((group) => (
        <Box key={group.title}>
          <Text
            fontSize="11px"
            color="#7d8590"
            textTransform="uppercase"
            letterSpacing="0.06em"
            mb="2"
          >
            {group.title}
          </Text>
          <Box>
            {group.rows.map((row, idx) => (
              <Flex
                key={idx}
                align="center"
                justify="space-between"
                py="1.5"
                borderBottom={idx < group.rows.length - 1 ? '1px solid #21262d' : 'none'}
                gap="3"
              >
                <Text fontSize="12px" color="#c9d1d9" flex="1">
                  {row.label}
                </Text>
                <Flex gap="1" flexShrink={0}>
                  {row.keys.map((k, i) => (
                    <Box
                      key={i}
                      px="1.5"
                      py="0.5"
                      minW="22px"
                      h="22px"
                      borderRadius="4px"
                      bg="#161b22"
                      border="1px solid #30363d"
                      color="#c9d1d9"
                      fontSize="11px"
                      fontFamily="var(--grove-mono)"
                      display="inline-flex"
                      alignItems="center"
                      justifyContent="center"
                    >
                      {k}
                    </Box>
                  ))}
                </Flex>
              </Flex>
            ))}
          </Box>
        </Box>
      ))}
    </Flex>
  );
}

function MaintenanceSection() {
  const [cleanup, setCleanup] = useState<CleanupState>({ status: 'idle' });

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

  // Scan once when the section is first shown.
  useEffect(() => {
    refresh();
  }, []);

  const deleteAll = async () => {
    if (cleanup.status !== 'list' || !window.grove?.workspace) return;
    const entries = cleanup.entries;
    setCleanup({ status: 'loading' });
    const res = await window.grove.workspace.deleteBranches({ entries });
    setCleanup({ status: 'done', deleted: res.deleted, errors: res.errors });
  };

  if (!window.grove?.workspace) {
    return (
      <Text fontSize="12px" color="#7d8590">
        Branch cleanup can only be managed from the Grove desktop app.
      </Text>
    );
  }

  return (
    <>
      <Flex align="center" justify="space-between" mb="1">
        <Text fontSize="13px" color="#f0f6fc">
          Grove branches
        </Text>
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
      {cleanup.status === 'loading' && (
        <Text fontSize="12px" color="#7d8590">
          Scanning…
        </Text>
      )}
      {cleanup.status === 'empty' && (
        <Text fontSize="12px" color="#c9d1d9">
          Nothing to clean up.
        </Text>
      )}
      {cleanup.status === 'list' && (
        <>
          <Box border="1px solid #30363d" borderRadius="6px" maxH="280px" overflowY="auto" mb="3">
            {cleanup.entries.map((e) => (
              <Flex
                key={`${e.repoRoot}\0${e.branch}`}
                px="3"
                py="2"
                borderBottom="1px solid #21262d"
                align="center"
                gap="2"
              >
                <Box flex="1" minW="0">
                  <Text
                    fontSize="12px"
                    color="#f0f6fc"
                    fontFamily="var(--grove-mono)"
                    truncate
                    title={`${e.branch}\n${shortPath(e.repoRoot)}`}
                  >
                    {e.branch}
                  </Text>
                  <Text fontSize="10px" color="#7d8590" truncate>
                    {shortPath(e.repoRoot)}
                  </Text>
                </Box>
                {e.worktreePath && (
                  <Text
                    fontSize="10px"
                    color="#d29922"
                    fontFamily="var(--grove-mono)"
                    flexShrink={0}
                    title={shortPath(e.worktreePath)}
                  >
                    orphan worktree
                  </Text>
                )}
              </Flex>
            ))}
          </Box>
          <button
            onClick={deleteAll}
            style={{
              background: 'transparent',
              border: '1px solid #30363d',
              color: '#c9d1d9',
              cursor: 'pointer',
              padding: '4px 12px',
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            Delete {cleanup.entries.length} {cleanup.entries.length === 1 ? 'entry' : 'entries'}
          </button>
        </>
      )}
      {cleanup.status === 'done' && (
        <>
          <Text fontSize="12px" color="#c9d1d9">
            Deleted {cleanup.deleted} branch{cleanup.deleted === 1 ? '' : 'es'}.
          </Text>
          {cleanup.errors.length > 0 && (
            <Box mt="2">
              <Text fontSize="11px" color="#f85149" mb="1">
                {cleanup.errors.length} failed:
              </Text>
              {cleanup.errors.map((err) => (
                <Text
                  key={err.branch}
                  fontSize="10px"
                  color="#7d8590"
                  fontFamily="var(--grove-mono)"
                  mb="0.5"
                >
                  {err.branch} — {err.message}
                </Text>
              ))}
            </Box>
          )}
        </>
      )}
    </>
  );
}

// Settings is a two-pane dialog: a category list on the left, the selected
// category's controls on the right. Each category is its own component so it
// mounts fresh (and re-reads its data) when navigated to.
const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'tabs', label: 'Tabs' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'remote', label: 'Remote access' },
  { id: 'maintenance', label: 'Maintenance' },
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<SettingsSectionId>('appearance');
  useHideBrowserOverlay(open);

  // Always land on the first category when the dialog is reopened.
  useEffect(() => {
    if (open) setSection('appearance');
  }, [open]);

  const activeLabel = SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? '';

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) onClose();
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop bg="rgba(0,0,0,0.5)" />
        <Dialog.Positioner>
          <Dialog.Content
            bg="#161b22"
            border={{ base: 'none', md: '1px solid #30363d' }}
            borderRadius={{ base: '0', md: '8px' }}
            boxShadow="0 20px 60px rgba(0,0,0,0.6)"
            w={{ base: '100vw', md: '700px' }}
            h={{ base: '100dvh', md: '520px' }}
            maxW={{ base: '100vw', md: '700px' }}
            maxH={{ base: '100dvh', md: '520px' }}
            display="flex"
            flexDirection="column"
            style={{
              // Full-screen on a phone — clear the notch / home indicator.
              paddingTop: 'env(safe-area-inset-top, 0px)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
          >
            <Dialog.Header
              px="4"
              py="3"
              borderBottom="1px solid #30363d"
              display="flex"
              alignItems="center"
              justifyContent="space-between"
            >
              <Dialog.Title fontSize="14px" color="#f0f6fc" fontWeight="600">
                Settings
              </Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" color="#7d8590" />
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Flex flex="1" minH="0">
              <Box
                w={{ base: '116px', md: '176px' }}
                flexShrink={0}
                borderRight="1px solid #30363d"
                py="3"
                px="2"
                overflowY="auto"
              >
                {SETTINGS_SECTIONS.map((s) => (
                  <Box
                    as="button"
                    key={s.id}
                    onClick={() => setSection(s.id)}
                    w="100%"
                    textAlign="left"
                    px="3"
                    py="2"
                    mb="0.5"
                    borderRadius="6px"
                    fontSize="13px"
                    cursor="pointer"
                    bg={section === s.id ? '#21262d' : 'transparent'}
                    color={section === s.id ? '#f0f6fc' : '#7d8590'}
                    fontWeight={section === s.id ? '600' : '400'}
                    _hover={{ bg: section === s.id ? '#21262d' : '#1c2128', color: '#c9d1d9' }}
                  >
                    {s.label}
                  </Box>
                ))}
              </Box>
              <Box flex="1" minW="0" overflowY="auto" overflowX="hidden" px="5" py="4">
                <Text fontSize="15px" color="#f0f6fc" fontWeight="600" mb="4">
                  {activeLabel}
                </Text>
                {section === 'appearance' && <AppearanceSection />}
                {section === 'tabs' && <TabsSection />}
                {section === 'shortcuts' && <ShortcutsSection />}
                {section === 'remote' && <RemoteAccessSection />}
                {section === 'maintenance' && <MaintenanceSection />}
              </Box>
            </Flex>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function SidebarToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <TitlebarIconButton
      active={open}
      title={open ? 'Hide sidebar (⌘\\)' : 'Show sidebar (⌘\\)'}
      onClick={onClick}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block' }}
      >
        <rect x="2" y="3" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <line x1="6.5" y1="3.5" x2="6.5" y2="14.5" stroke="currentColor" strokeWidth="1.3" />
        {open && <rect x="3" y="4" width="3" height="10" fill="currentColor" opacity="0.25" />}
      </svg>
    </TitlebarIconButton>
  );
}
