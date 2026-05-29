import { useEffect, useRef, useState, useCallback } from 'react';
import { Box, Flex, HStack, Input, Text } from '@chakra-ui/react';
import { useStore } from './store';
import { API_BASE } from './api';
import { SquareLoader } from './SquareLoader';

interface ServiceEntry {
  port: number;
  host: string;
  pid: number;
  cmd: string;
  cwd: string | null;
  url: string;
}

interface ServicesResponse {
  services: ServiceEntry[];
  cwd: string | null;
  cwdReady?: boolean;
}

export function BrowserPanel({
  forcedFullscreen = false,
  paneId,
}: {
  forcedFullscreen?: boolean;
  panelWidth: number;
  paneId?: string;
}) {
  const activeTabId = useStore((s) => s.activeTabId);
  const setPaneState = useStore((s) => s.setPaneState);
  // Per-pane URL. The Electron WebContentsView is still a process singleton
  // (slice 3) so two browser panes today render the most-recently-navigated
  // URL, but each pane remembers its own address-bar input + history scope.
  const url = useStore((s) => {
    if (paneId) {
      const ps = s.paneState[paneId];
      if (ps && ps.kind === 'browser') return ps.url ?? null;
    }
    return s.browserPanelUrl;
  });
  const setUrl = (next: string | null) => {
    if (paneId) setPaneState(paneId, { kind: 'browser', url: next });
    // Also mirror to the legacy global so the WebContentsView's actual
    // navigation request reaches main via setBrowserPanelUrl's existing
    // pathway (history recording, normalization).
    useStore.getState().setBrowserPanelUrl(next);
  };
  const removeHistory = useStore((s) => s.removeBrowserHistory);
  void forcedFullscreen;
  // Recents are scoped to the active tab's workspace cwd so each project sees
  // its own set of URLs.
  const groupCwd = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab ? (s.groups.find((g) => g.id === tab.groupId)?.cwd ?? '') : '';
  });
  const history = useStore((s) => s.browserHistory.filter((h) => h.cwd === groupCwd));

  const [services, setServices] = useState<ServiceEntry[] | null>(null);
  const [cwdReady, setCwdReady] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [addr, setAddr] = useState(url ?? '');
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const stageRef = useRef<HTMLDivElement | null>(null);

  const MOBILE_WIDTH = 390; // iPhone 14/15 logical width
  const DESKTOP_WIDTH = 1280; // logical desktop viewport kept regardless of panel width

  // Each browser pane owns its own WebContentsView in main, keyed by pane id.
  // Fall back to a stable placeholder if no paneId was passed (lets the
  // panel still work in legacy single-instance call sites during migration).
  const id = paneId ?? 'browser';
  const reload = () => {
    window.grove?.browser?.reload(id);
  };
  const goBack = () => {
    window.grove?.browser?.back(id);
  };
  const goForward = () => {
    window.grove?.browser?.forward(id);
  };

  useEffect(() => {
    setAddr(url ?? '');
  }, [url]);

  const [frameError, setFrameError] = useState<{ code: number; message: string } | null>(null);
  const [navState, setNavState] = useState({ canGoBack: false, canGoForward: false });

  useEffect(() => {
    const b = window.grove?.browser;
    if (!b) return;
    // Filter events to this pane only — other browser panes broadcast on
    // the same channels but should not steer this panel's UI state.
    const offNav = b.onNav((ev) => {
      if (ev.paneId !== id) return;
      setAddr(ev.url);
      setFrameError(null);
    });
    const offNavState = b.onNavState((s) => {
      if (s.paneId !== id) return;
      setNavState({ canGoBack: s.canGoBack, canGoForward: s.canGoForward });
    });
    const offFail = b.onFail((info) => {
      if (info.paneId !== id) return;
      setFrameError({ code: info.code, message: info.message });
    });
    const offLoading = b.onLoading((ev) => {
      if (ev.paneId !== id) return;
      if (ev.loading) setFrameError(null);
    });
    return () => {
      offNav();
      offNavState();
      offFail();
      offLoading();
    };
  }, [id]);
  useEffect(() => {
    setFrameError(null);
    window.grove?.browser?.clearFail?.(id);
  }, [url, id]);

  // Drive the WebContentsView for this pane: open/navigate when a URL is
  // set, remove it from the window when showing the services list, destroy
  // it when the panel unmounts (i.e., the pane was closed in the tree).
  useEffect(() => {
    const b = window.grove?.browser;
    if (!b) return;
    if (url) b.open(id, url);
    else b.close(id);
  }, [url, id]);
  useEffect(
    () => () => {
      window.grove?.browser?.destroy(id);
    },
    [id],
  );

  // The view is an OS-compositor layer above the DOM — it can't be positioned
  // with CSS. Instead we mirror the placeholder Box's screen rect into the
  // view's bounds every frame (cheap: a getBoundingClientRect + string compare)
  // so it tracks panel resize, fullscreen, sidebar, and width transitions.
  // Mobile uses a real 390px-wide viewport centered in the stage. Desktop
  // keeps a 1280px logical viewport: when the panel is narrower we zoom the
  // page out (zoomFactor < 1 widens the CSS viewport) so the full desktop
  // layout still fits without a horizontal scrollbar. While an error overlay
  // is showing we park the view offscreen so the DOM shows.
  useEffect(() => {
    const b = window.grove?.browser;
    if (!url || !b) return;
    let raf = 0;
    let lastKey = '';
    const tick = () => {
      const el = stageRef.current;
      if (el && !frameError) {
        const r = el.getBoundingClientRect();
        const isMobile = viewport === 'mobile';
        const width = isMobile ? Math.min(MOBILE_WIDTH, r.width) : r.width;
        const x = r.left + (isMobile ? (r.width - width) / 2 : 0);
        const zoom =
          !isMobile && r.width < DESKTOP_WIDTH && r.width > 0 ? r.width / DESKTOP_WIDTH : 1;
        const key = `${Math.round(x)}|${Math.round(r.top)}|${Math.round(width)}|${Math.round(r.height)}|${zoom.toFixed(3)}`;
        if (key !== lastKey) {
          lastKey = key;
          b.setBounds(id, { x, y: r.top, width, height: r.height, zoom });
        }
      } else if (lastKey !== 'hidden') {
        lastKey = 'hidden';
        b.setBounds(id, null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [url, viewport, frameError]);

  const fetchServices = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (activeTabId) params.set('tabId', activeTabId);
      const res = await fetch(`${API_BASE}/services?${params.toString()}`);
      const json: ServicesResponse = await res.json();
      const ready = json.cwdReady !== false;
      setCwdReady(ready);
      setServices(ready ? json.services : null);
    } catch (err) {
      console.error('[grove] fetch services failed', err);
      setCwdReady(true);
      setServices([]);
    }
  }, [activeTabId]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices, refreshNonce]);

  // Re-scan every 4s while the list is showing so newly-started dev servers
  // appear without manual refresh.
  useEffect(() => {
    if (url) return;
    const t = setInterval(() => setRefreshNonce((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [url]);

  const onSubmitAddr = (e: React.FormEvent) => {
    e.preventDefault();
    let v = addr.trim();
    if (!v) return;
    if (!/^https?:\/\//.test(v)) v = `http://${v}`;
    setUrl(v);
  };

  return (
    <Flex direction="column" h="100%" w="100%" bg="#010409" borderLeft="1px solid #21262d">
      <Flex
        align="center"
        gap="1.5"
        px="2"
        h={url ? '36px' : '0px'}
        borderBottom={url ? '1px solid #21262d' : 'none'}
        bg="#0d1117"
        flexShrink={0}
        overflow="hidden"
      >
        {url ? (
          <>
            <HeaderIconButton title="Workspace services" onClick={() => setUrl(null)}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              >
                <rect x="1.5" y="1.5" width="3.5" height="3.5" rx="0.6" />
                <rect x="7" y="1.5" width="3.5" height="3.5" rx="0.6" />
                <rect x="1.5" y="7" width="3.5" height="3.5" rx="0.6" />
                <rect x="7" y="7" width="3.5" height="3.5" rx="0.6" />
              </svg>
            </HeaderIconButton>
            <HeaderIconButton title="Back" onClick={goBack} disabled={!navState.canGoBack}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7.5 2.5L4 6l3.5 3.5" />
              </svg>
            </HeaderIconButton>
            <HeaderIconButton title="Forward" onClick={goForward} disabled={!navState.canGoForward}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4.5 2.5L8 6l-3.5 3.5" />
              </svg>
            </HeaderIconButton>
            <Box as="form" onSubmit={onSubmitAddr} flex="1">
              <Input
                size="xs"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                fontSize="12px"
                bg="#161b22"
                borderColor="#30363d"
                color="#c9d1d9"
                borderRadius="full"
                px="3"
                h="24px"
                placeholder="http://127.0.0.1:5173"
                _focus={{ borderColor: '#1f6feb', boxShadow: '0 0 0 1px #1f6feb' }}
              />
            </Box>
            <HeaderIconButton
              title={viewport === 'mobile' ? 'Switch to desktop' : 'Switch to mobile'}
              active={viewport === 'mobile'}
              onClick={() => setViewport((v) => (v === 'mobile' ? 'desktop' : 'mobile'))}
            >
              {viewport === 'mobile' ? (
                // Desktop monitor — switching back to desktop layout
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="1.5" y="2.5" width="11" height="7.5" rx="1" />
                  <path d="M5 12.5h4" />
                  <path d="M7 10v2.5" />
                </svg>
              ) : (
                // Phone — switching to mobile viewport
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="4" y="1.5" width="6" height="11" rx="1.2" />
                  <path d="M5.75 3h2.5" />
                  <circle cx="7" cy="11" r="0.5" fill="currentColor" />
                </svg>
              )}
            </HeaderIconButton>
            <HeaderIconButton title="Reload" onClick={reload}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9.5 3.5V2M9.5 3.5H8" />
                <path d="M9.5 3.5A4 4 0 1 0 10 6.5" />
              </svg>
            </HeaderIconButton>
            <HeaderIconButton
              title="Open in system browser"
              onClick={() => {
                if (url) window.grove?.openExternal?.(url);
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6.5 3H3v8h8V7.5" />
                <path d="M8 3h3v3" />
                <path d="M6 8L11 3" />
              </svg>
            </HeaderIconButton>
          </>
        ) : (
          <Box flex="1" />
        )}
        <Flex align="center" gap="1">
          {!url && (
            <HeaderIconButton title="Refresh" onClick={() => setRefreshNonce((n) => n + 1)}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9.5 3.5V2M9.5 3.5H8" />
                <path d="M9.5 3.5A4 4 0 1 0 10 6.5" />
              </svg>
            </HeaderIconButton>
          )}
        </Flex>
      </Flex>
      <Box flex="1" minH="0" position="relative">
        {url ? (
          // Placeholder for the WebContentsView. The view itself is an
          // OS-compositor layer painted above this Box by the main process;
          // its bounds are synced to this Box's screen rect every frame. When
          // a load fails the view is parked offscreen and this DOM error
          // surface shows in its place.
          <Box ref={stageRef} position="absolute" inset="0" overflow="hidden" bg="#0d1117">
            {frameError && <FrameErrorView url={url} info={frameError} onRetry={reload} />}
          </Box>
        ) : (
          <ServicesList
            services={services}
            history={history}
            onPick={(s) => setUrl(s.url)}
            onPickHistory={(u) => setUrl(u)}
            onRemoveHistory={(u) => removeHistory(u, groupCwd)}
            onCustom={onSubmitAddr}
            addr={addr}
            setAddr={setAddr}
          />
        )}
      </Box>
    </Flex>
  );
}

function ServicesList(props: {
  services: ServiceEntry[] | null;
  history: Array<{ url: string; visitedAt: number }>;
  onPick: (s: ServiceEntry) => void;
  onPickHistory: (url: string) => void;
  onRemoveHistory: (url: string) => void;
  onCustom: (e: React.FormEvent) => void;
  addr: string;
  setAddr: (v: string) => void;
}) {
  return <EmptyBrowserState {...props} />;
}

// Chrome-like empty state: centered omnibox at the top of the panel,
// suggestion dropdown directly below combining recent URLs and live
// workspace services. The input auto-focuses on mount and supports
// arrow-key navigation through the suggestions.
function EmptyBrowserState({
  services,
  history,
  onPick,
  onPickHistory,
  onRemoveHistory,
  onCustom,
  addr,
  setAddr,
}: {
  services: ServiceEntry[] | null;
  history: Array<{ url: string; visitedAt: number }>;
  onPick: (s: ServiceEntry) => void;
  onPickHistory: (url: string) => void;
  onRemoveHistory: (url: string) => void;
  onCustom: (e: React.FormEvent) => void;
  addr: string;
  setAddr: (v: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  // Autofocus the omnibox on mount so the user can just start typing.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Build the suggestion list: live services first, then recents that aren't
  // already represented by a live service. Filter by current address text
  // (substring against either url or service command/host) so the dropdown
  // narrows like Chrome's omnibox.
  const liveUrls = new Set((services ?? []).map((s) => s.url));
  const recents = history.filter((h) => !liveUrls.has(h.url));
  const query = addr.trim().toLowerCase();
  const matches = (text: string) => !query || text.toLowerCase().includes(query);
  const filteredServices = (services ?? []).filter(
    (s) => matches(s.url) || matches(s.cmd) || matches(`${displayHost(s.host)}:${s.port}`),
  );
  const filteredRecents = recents.filter((h) => matches(h.url));

  type Row =
    | { kind: 'service'; service: ServiceEntry }
    | { kind: 'recent'; entry: { url: string; visitedAt: number } };
  const rows: Row[] = [
    ...filteredServices.map((s): Row => ({ kind: 'service', service: s })),
    ...filteredRecents.map((e): Row => ({ kind: 'recent', entry: e })),
  ];
  const total = rows.length;

  // Re-clamp highlight whenever the row count changes (filter narrowed).
  useEffect(() => {
    if (highlight >= total && total > 0) setHighlight(total - 1);
    if (total === 0) setHighlight(0);
  }, [total, highlight]);

  const choose = (idx: number) => {
    const row = rows[idx];
    if (!row) return;
    if (row.kind === 'service') onPick(row.service);
    else onPickHistory(row.entry.url);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && total > 0) {
      e.preventDefault();
      setHighlight((h) => (h + 1) % total);
    } else if (e.key === 'ArrowUp' && total > 0) {
      e.preventDefault();
      setHighlight((h) => (h - 1 + total) % total);
    } else if (e.key === 'Enter' && total > 0 && highlight >= 0 && highlight < total) {
      // Highlighted suggestion wins over free text — same as Chrome.
      e.preventDefault();
      choose(highlight);
    }
  };

  return (
    <Box position="relative" h="100%" w="100%" overflow="hidden">
      {/* Wrapper anchored so the input's vertical midline sits at panel
          center (top = 50% - half input height). The dropdown grows downward
          below the input without moving it. */}
      <Box
        position="absolute"
        left="50%"
        top="calc(50% - 20px)"
        transform="translateX(-50%)"
        w="100%"
        maxW="640px"
        px="6"
      >
        <Box
          as="form"
          onSubmit={(e: React.FormEvent) => onCustom(e)}
          bg="#161b22"
          border="1px solid"
          borderColor={isFocused ? '#1f6feb' : '#30363d'}
          borderRadius="20px"
          boxShadow={
            isFocused
              ? '0 0 0 2px rgba(31,111,235,0.35), 0 12px 32px rgba(0,0,0,0.45)'
              : '0 0 0 0 rgba(31,111,235,0), 0 0 0 rgba(0,0,0,0)'
          }
          overflow="hidden"
          style={{
            transition:
              'border-color 180ms ease, box-shadow 180ms ease',
          }}
        >
          <Input
            ref={inputRef}
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Search workspace services or enter a URL"
            fontSize="14px"
            bg="transparent"
            color="#f0f6fc"
            border="none"
            borderRadius="0"
            px="5"
            h="40px"
            spellCheck={false}
            autoComplete="off"
            _focus={{ boxShadow: 'none', outline: 'none' }}
          />

          {/* Suggestion area — kept mounted so we can smoothly animate its
              open/close. `grid-template-rows: 0fr/1fr` is the standard
              auto-height transition; opacity rides alongside for a nice
              fade. Mousedown preventDefault on the children keeps the input
              from blurring before a click registers. */}
          <Box
            display="grid"
            style={{
              gridTemplateRows: isFocused ? '1fr' : '0fr',
              opacity: isFocused ? 1 : 0,
              transition: 'grid-template-rows 180ms ease, opacity 180ms ease',
            }}
            onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
          >
            <Box
              maxH="320px"
              overflowY={isFocused ? 'auto' : 'hidden'}
              borderTop={isFocused && (total > 0 || query) ? '1px solid #21262d' : 'none'}
              style={{ minHeight: 0 }}
            >
              {services === null ? (
                <Flex h="80px" align="center" justify="center">
                  <SquareLoader />
                </Flex>
              ) : total === 0 ? (
                query ? (
                  <Box px="5" py="3">
                    <Text fontSize="12px" color="#7d8590">
                      No matches for "{addr}". Press Enter to load this URL.
                    </Text>
                  </Box>
                ) : null
              ) : (
                <Box bg="transparent">
            {rows.map((row, idx) => {
              const isActive = idx === highlight;
              if (row.kind === 'service') {
                const s = row.service;
                return (
                  <Box
                    key={`s:${s.pid}:${s.port}`}
                    as="button"
                    w="100%"
                    textAlign="left"
                    px="3"
                    py="2"
                    bg={isActive ? '#1f2937' : 'transparent'}
                    border="none"
                    cursor="pointer"
                    _hover={{ bg: isActive ? '#1f2937' : '#161b22' }}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => choose(idx)}
                    borderBottom={idx < rows.length - 1 ? '1px solid #161b22' : undefined}
                  >
                    <HStack gap="2" align="baseline">
                      <Text fontFamily="var(--grove-mono)" fontSize="13px" color="#79c0ff">
                        {displayHost(s.host)}:{s.port}
                      </Text>
                      <Text fontSize="12px" color="#c9d1d9">
                        {s.cmd}
                      </Text>
                      <Text fontSize="11px" color="#7d8590">
                        pid {s.pid}
                      </Text>
                    </HStack>
                    {s.cwd && (
                      <Text
                        fontSize="11px"
                        color="#7d8590"
                        fontFamily="var(--grove-mono)"
                        mt="0.5"
                      >
                        {s.cwd}
                      </Text>
                    )}
                  </Box>
                );
              }
              const h = row.entry;
              return (
                <Flex
                  key={`r:${h.url}`}
                  align="center"
                  px="3"
                  py="2"
                  gap="2"
                  bg={isActive ? '#1f2937' : 'transparent'}
                  borderBottom={idx < rows.length - 1 ? '1px solid #161b22' : undefined}
                  onMouseEnter={() => setHighlight(idx)}
                  _hover={{
                    bg: isActive ? '#1f2937' : '#161b22',
                    '& .grove-recent-x': { opacity: 1 },
                  }}
                >
                  <Box
                    as="button"
                    flex="1"
                    textAlign="left"
                    bg="transparent"
                    border="none"
                    cursor="pointer"
                    onClick={() => choose(idx)}
                  >
                    <Text fontFamily="var(--grove-mono)" fontSize="13px" color="#c9d1d9">
                      {h.url}
                    </Text>
                  </Box>
                  <Box
                    as="button"
                    className="grove-recent-x"
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      onRemoveHistory(h.url);
                    }}
                    opacity="0"
                    transition="opacity 0.12s"
                    cursor="pointer"
                    bg="transparent"
                    border="none"
                    color="#7d8590"
                    _hover={{ color: '#c9d1d9' }}
                    title="Remove"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    >
                      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                    </svg>
                  </Box>
                </Flex>
              );
            })}
                </Box>
              )}
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

// Services that bind to a wildcard address (`*` from lsof, or 0.0.0.0 / ::)
// are reachable on localhost; show the host the user would actually click,
// not the kernel's wildcard token.
function displayHost(host: string): string {
  if (host === '*' || host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1';
  if (host === '[::1]' || host === '::1') return '127.0.0.1';
  return host;
}

function FrameErrorView({
  url,
  info,
  onRetry,
}: {
  url: string;
  info: { code: number; message: string };
  onRetry: () => void;
}) {
  // Map common Chromium net error codes to a clearer "what went wrong" line.
  const reason = (() => {
    switch (info.code) {
      case -7:
        return 'The connection timed out.';
      case -21:
        return 'Network changed during the request.';
      case -101:
        return 'The connection was reset.';
      case -102:
        return 'The site refused to connect.';
      case -105:
        return 'The server’s address could not be found.';
      case -106:
        return 'No internet connection.';
      case -109:
        return 'The address was unreachable.';
      case -118:
        return 'The connection attempt timed out.';
      case -137:
        return 'Could not resolve the host.';
      case -201:
        return 'The server certificate is invalid.';
      default:
        return info.message || 'The page failed to load.';
    }
  })();
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  return (
    <Flex
      position="absolute"
      inset="0"
      direction="column"
      align="flex-start"
      justify="center"
      bg="#0d1117"
      px="10"
      gap="3"
      maxW="640px"
    >
      <Box>
        <svg
          width="36"
          height="36"
          viewBox="0 0 36 36"
          fill="none"
          stroke="#7d8590"
          strokeWidth="1.4"
        >
          <circle cx="18" cy="18" r="14" />
          <path d="M12 18l12 0M18 12c2.5 3.5 2.5 8.5 0 12M18 12c-2.5 3.5-2.5 8.5 0 12" />
          <path d="M9 27l18-18" stroke="#7d8590" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </Box>
      <Text fontSize="22px" color="#c9d1d9" fontWeight="600">
        This site can’t be reached
      </Text>
      <Text fontSize="13px" color="#7d8590">
        <Box as="span" color="#c9d1d9">
          {host}
        </Box>{' '}
        {reason.toLowerCase().replace(/\.$/, '')}.
      </Text>
      <Text fontSize="12px" color="#6e7681" fontFamily="var(--grove-mono)">
        ERR_CODE {info.code}
      </Text>
      <Flex mt="2" gap="2">
        <Box
          as="button"
          onClick={onRetry}
          px="3"
          py="1.5"
          bg="#1f6feb"
          color="#ffffff"
          fontSize="12px"
          fontWeight="600"
          borderRadius="6px"
          cursor="pointer"
          _hover={{ bg: '#388bfd' }}
        >
          Reload
        </Box>
        <Box
          as="button"
          onClick={() => window.grove?.openExternal?.(url)}
          px="3"
          py="1.5"
          bg="transparent"
          color="#c9d1d9"
          fontSize="12px"
          fontWeight="600"
          border="1px solid #30363d"
          borderRadius="6px"
          cursor="pointer"
          _hover={{ bg: '#21262d' }}
        >
          Open in system browser
        </Box>
      </Flex>
    </Flex>
  );
}

function HeaderIconButton({
  children,
  title,
  onClick,
  active,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const bg = disabled ? 'transparent' : active ? '#30363d' : hover ? '#21262d' : 'transparent';
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      disabled={disabled}
      style={{
        background: bg,
        border: 'none',
        color: '#c9d1d9',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        padding: 0,
        height: '24px',
        width: '24px',
        flexShrink: 0,
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 120ms ease, opacity 120ms ease',
      }}
    >
      {children}
    </button>
  );
}
