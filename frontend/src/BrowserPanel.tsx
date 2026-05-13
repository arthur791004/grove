import { useEffect, useRef, useState, useCallback } from 'react';
import { Box, Flex, HStack, Input, Text } from '@chakra-ui/react';
import { useStore } from './store';
import { API_BASE } from './api';

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
}: {
  forcedFullscreen?: boolean;
  panelWidth: number;
}) {
  const activeTabId = useStore((s) => s.activeTabId);
  const togglePanel = useStore((s) => s.toggleBrowserPanel);
  const fullscreen = useStore((s) => s.browserPanelFullscreen);
  const toggleFullscreen = useStore((s) => s.toggleBrowserPanelFullscreen);
  const url = useStore((s) => s.browserPanelUrl);
  const setUrl = useStore((s) => s.setBrowserPanelUrl);
  const removeHistory = useStore((s) => s.removeBrowserHistory);
  // Recents are scoped to the active tab's workspace cwd so each project sees
  // its own set of URLs.
  const groupCwd = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab ? s.groups.find((g) => g.id === tab.groupId)?.cwd ?? '' : '';
  });
  const history = useStore((s) => s.browserHistory.filter((h) => h.cwd === groupCwd));

  const [services, setServices] = useState<ServiceEntry[] | null>(null);
  const [cwdReady, setCwdReady] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [addr, setAddr] = useState(url ?? '');
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [iframeNonce, setIframeNonce] = useState(0);
  const [stageW, setStageW] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const MOBILE_WIDTH = 390; // iPhone 14/15 logical width
  const DESKTOP_WIDTH = 1280;

  // Measure the iframe stage so we can scale the 1280px viewport down to fit
  // narrower panels without showing a horizontal scrollbar.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setStageW(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [url]);

  // Force the iframe to reload by bumping a nonce that's used as a key. Plain
  // <iframe> doesn't expose a reliable reload() across cross-origin pages.
  const reloadIframe = () => setIframeNonce((n) => n + 1);

  useEffect(() => { setAddr(url ?? ''); }, [url]);

  // Sub-frame navigations are forwarded by the main process via IPC because
  // same-origin policy hides them from the renderer. Update only the visible
  // address bar — don't reset the iframe src, which would reload the page.
  useEffect(() => {
    if (!window.grove?.onFrameNav) return;
    return window.grove.onFrameNav((u) => setAddr(u));
  }, []);

  const [frameError, setFrameError] = useState<{ code: number; message: string } | null>(null);
  // Track load failures (server down, DNS, refused) and clear on each new
  // load. The iframe key bump triggers a fresh load → clear stale errors.
  // Preload buffers the last fail so we still catch failures that fired
  // before this listener mounted (instant ECONNREFUSED is faster than
  // React's first useEffect). Clearing on url/iframeNonce change handles
  // user-initiated reloads/navigations.
  useEffect(() => {
    if (!window.grove?.onFrameFail) return;
    return window.grove.onFrameFail((info) => setFrameError({ code: info.code, message: info.message }));
  }, []);
  useEffect(() => {
    setFrameError(null);
    window.grove?.clearFrameFail?.();
  }, [url, iframeNonce]);

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

  useEffect(() => { fetchServices(); }, [fetchServices, refreshNonce]);

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

  const effectiveFs = forcedFullscreen || fullscreen;

  return (
    <Flex direction="column" h="100%" w="100%" bg="#010409" borderLeft="1px solid #21262d">
      <Flex
        align="center"
        gap="1.5"
        px="2"
        h="36px"
        borderBottom="1px solid #21262d"
        bg="#0d1117"
        flexShrink={0}
      >
        {!url && (
          <Text fontSize="12px" color="#c9d1d9" ml="1">
            Workspace services
          </Text>
        )}
        {url ? (
          <>
            <HeaderIconButton title="Back to services" onClick={() => setUrl(null)}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7.5 2L3.5 6l4 4" />
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
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1.5" y="2.5" width="11" height="7.5" rx="1" />
                  <path d="M5 12.5h4" />
                  <path d="M7 10v2.5" />
                </svg>
              ) : (
                // Phone — switching to mobile viewport
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="1.5" width="6" height="11" rx="1.2" />
                  <path d="M5.75 3h2.5" />
                  <circle cx="7" cy="11" r="0.5" fill="currentColor" />
                </svg>
              )}
            </HeaderIconButton>
            <HeaderIconButton title="Reload" onClick={reloadIframe}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.5 3.5V2M9.5 3.5H8" />
                <path d="M9.5 3.5A4 4 0 1 0 10 6.5" />
              </svg>
            </HeaderIconButton>
            <HeaderIconButton
              title="Open in system browser"
              onClick={() => { if (url) window.grove?.openExternal?.(url); }}
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
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
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.5 3.5V2M9.5 3.5H8" />
                <path d="M9.5 3.5A4 4 0 1 0 10 6.5" />
              </svg>
            </HeaderIconButton>
          )}
          {!forcedFullscreen && (
            <HeaderIconButton
              title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              onClick={toggleFullscreen}
            >
              {fullscreen
                ? <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"><path d="M10 2L6.5 5.5M6.5 5.5V2.5M6.5 5.5H9.5M2 10l3.5-3.5M5.5 6.5v3M5.5 6.5h-3" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                : <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"><path d="M7 2h3v3M10 2L6.5 5.5M5 10H2V7M2 10l3.5-3.5" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
              }
            </HeaderIconButton>
          )}
          <HeaderIconButton title="Close" onClick={togglePanel}>
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </HeaderIconButton>
        </Flex>
      </Flex>
      <Box flex="1" minH="0" position="relative">
        {url ? (
          (() => {
            const isMobile = viewport === 'mobile';
            // Mobile is always a fixed 390 frame (auto-fit if the panel is
            // narrower). Desktop has DESKTOP_WIDTH as a *minimum* viewport
            // — when the panel is wider we let the iframe stretch to fill
            // the panel so no empty space is wasted.
            const frameW = isMobile
              ? MOBILE_WIDTH
              : Math.max(DESKTOP_WIDTH, stageW || DESKTOP_WIDTH);
            const scale = stageW > 0 && stageW < frameW ? stageW / frameW : 1;
            // Center the mobile frame when there's extra panel width; desktop
            // grows to fill so no centering needed.
            const offsetX = isMobile && scale === 1 && stageW > frameW
              ? (stageW - frameW) / 2
              : 0;
            return (
              <Box ref={stageRef} position="absolute" inset="0" overflow="hidden" bg="#0d1117">
                <Box
                  position="absolute"
                  top="0"
                  left={`${offsetX}px`}
                  w={`${frameW}px`}
                  h={scale < 1 ? `${100 / scale}%` : '100%'}
                  transform={`scale(${scale})`}
                  transformOrigin="top left"
                  visibility={frameError ? 'hidden' : 'visible'}
                >
                  <iframe
                    key={iframeNonce}
                    ref={iframeRef}
                    src={url}
                    title="Embedded browser"
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'block',
                      border: 'none',
                      background: '#ffffff',
                      boxShadow: '0 0 0 1px #30363d',
                    }}
                  />
                </Box>
                {frameError && (
                  <FrameErrorView url={url} info={frameError} onRetry={reloadIframe} />
                )}
              </Box>
            );
          })()
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
      <Box position="absolute" />
      {effectiveFs && null}
    </Flex>
  );
}

function ServicesList({
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
  // Hide recents that match a live service to avoid duplicates.
  const liveUrls = new Set((services ?? []).map((s) => s.url));
  const recents = history.filter((h) => !liveUrls.has(h.url));
  return (
    <Flex direction="column" h="100%" overflow="hidden">
      <Box flex="1" overflowY="auto">
        {services === null ? (
          <Flex h="100%" align="center" justify="center"><LoadingDots /></Flex>
        ) : services.length === 0 && recents.length === 0 ? (
          <Flex h="100%" direction="column" align="center" justify="center" gap="2" color="#7d8590" fontSize="12px" px="6" textAlign="center">
            <Text>No listening services in this workspace.</Text>
            <Text fontSize="11px">Start a dev server, then click Refresh.</Text>
          </Flex>
        ) : (
          <>
            {services.map((s) => (
              <Box
                key={`${s.pid}:${s.port}`}
                as="button"
                w="100%"
                textAlign="left"
                px="3"
                py="2"
                bg="transparent"
                borderBottom="1px solid #161b22"
                cursor="pointer"
                _hover={{ bg: '#0d1117' }}
                onClick={() => onPick(s)}
              >
                <HStack gap="2" align="baseline">
                  <Text fontFamily="var(--grove-mono)" fontSize="13px" color="#79c0ff">
                    {displayHost(s.host)}:{s.port}
                  </Text>
                  <Text fontSize="12px" color="#c9d1d9">{s.cmd}</Text>
                  <Text fontSize="11px" color="#7d8590">pid {s.pid}</Text>
                </HStack>
                {s.cwd && (
                  <Text fontSize="11px" color="#7d8590" fontFamily="var(--grove-mono)" mt="0.5">
                    {s.cwd}
                  </Text>
                )}
              </Box>
            ))}
            {recents.length > 0 && (
              <>
                <Box px="3" py="1.5" bg="#0d1117" borderTop="1px solid #161b22" borderBottom="1px solid #161b22">
                  <Text fontSize="10px" color="#7d8590" textTransform="uppercase" letterSpacing="0.06em">
                    Recent
                  </Text>
                </Box>
                {recents.map((h) => (
                  <Flex
                    key={h.url}
                    align="center"
                    px="3"
                    py="2"
                    gap="2"
                    borderBottom="1px solid #161b22"
                    _hover={{ bg: '#0d1117', '& .grove-recent-x': { opacity: 1 } }}
                  >
                    <Box
                      as="button"
                      flex="1"
                      textAlign="left"
                      bg="transparent"
                      cursor="pointer"
                      onClick={() => onPickHistory(h.url)}
                    >
                      <Text fontFamily="var(--grove-mono)" fontSize="13px" color="#c9d1d9">
                        {h.url}
                      </Text>
                    </Box>
                    <Box
                      as="button"
                      className="grove-recent-x"
                      onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRemoveHistory(h.url); }}
                      opacity="0"
                      transition="opacity 0.12s"
                      cursor="pointer"
                      bg="transparent"
                      border="none"
                      color="#7d8590"
                      _hover={{ color: '#c9d1d9' }}
                      title="Remove"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                      </svg>
                    </Box>
                  </Flex>
                ))}
              </>
            )}
          </>
        )}
      </Box>
      <Box as="form" onSubmit={onCustom} px="3" py="2" borderTop="1px solid #21262d" flexShrink={0}>
        <Input
          size="xs"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="Or enter a URL: 127.0.0.1:5173"
          fontSize="12px"
          bg="#161b22"
          borderColor="#30363d"
          color="#c9d1d9"
          borderRadius="full"
          px="3"
          h="26px"
          _focus={{ borderColor: '#1f6feb', boxShadow: '0 0 0 1px #1f6feb' }}
        />
      </Box>
    </Flex>
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

function FrameErrorView({ url, info, onRetry }: { url: string; info: { code: number; message: string }; onRetry: () => void }) {
  // Map common Chromium net error codes to a clearer "what went wrong" line.
  const reason = (() => {
    switch (info.code) {
      case -7: return 'The connection timed out.';
      case -21: return 'Network changed during the request.';
      case -101: return 'The connection was reset.';
      case -102: return 'The site refused to connect.';
      case -105: return 'The server’s address could not be found.';
      case -106: return 'No internet connection.';
      case -109: return 'The address was unreachable.';
      case -118: return 'The connection attempt timed out.';
      case -137: return 'Could not resolve the host.';
      case -201: return 'The server certificate is invalid.';
      default: return info.message || 'The page failed to load.';
    }
  })();
  let host = url;
  try { host = new URL(url).host; } catch {}
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
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="#7d8590" strokeWidth="1.4">
          <circle cx="18" cy="18" r="14" />
          <path d="M12 18l12 0M18 12c2.5 3.5 2.5 8.5 0 12M18 12c-2.5 3.5-2.5 8.5 0 12" />
          <path d="M9 27l18-18" stroke="#7d8590" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </Box>
      <Text fontSize="22px" color="#c9d1d9" fontWeight="600">This site can’t be reached</Text>
      <Text fontSize="13px" color="#7d8590">
        <Box as="span" color="#c9d1d9">{host}</Box> {reason.toLowerCase().replace(/\.$/, '')}.
      </Text>
      <Text fontSize="12px" color="#6e7681" fontFamily="var(--grove-mono)">
        ERR_CODE {info.code}
      </Text>
      <Box
        as="button"
        onClick={onRetry}
        mt="2"
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
    </Flex>
  );
}

function LoadingDots() {
  return (
    <div className="grove-sq-loader">
      <span /><span /><span /><span />
    </div>
  );
}

function HeaderIconButton({
  children, title, onClick, active,
}: { children: React.ReactNode; title: string; onClick: () => void; active?: boolean }) {
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
        color: '#c9d1d9',
        cursor: 'pointer',
        padding: 0,
        height: '24px',
        width: '24px',
        flexShrink: 0,
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 120ms ease',
      }}
    >
      {children}
    </button>
  );
}
