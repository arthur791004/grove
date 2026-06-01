// Browser-pane header URL omnibox. Rendered in the overlay window so it
// floats above the native WebContentsView and the page stays visible
// underneath, instead of having to park the browser pane offscreen the
// way useHideBrowserOverlay does.
//
// Visual model mirrors EmptyBrowserState: a pill-shaped card containing
// the input and the suggestion list as an attached expansion — same look
// as the initial browser screen, just anchored to the header URL bar's
// screen position instead of the panel center.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Flex, HStack, Input, Text } from '@chakra-ui/react';
import { useStore } from './store';
import { SquareLoader } from './SquareLoader';
import { FADE_MS } from './useFadePresence';

type Service = NonNullable<
  NonNullable<ReturnType<typeof useStore.getState>['headerOmnibox']>['services']
>[number];

function displayHost(host: string): string {
  if (host === '*' || host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1';
  if (host === '[::1]' || host === '::1') return '127.0.0.1';
  return host;
}

function normalizeAddr(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  return /^https?:\/\//.test(v) ? v : `http://${v}`;
}

export function HeaderOmnibox() {
  const omni = useStore((s) => s.headerOmnibox);
  const setResult = useStore((s) => s.setHeaderOmniboxResult);
  const inputRef = useRef<HTMLInputElement>(null);
  const [addr, setAddr] = useState('');
  const [highlight, setHighlight] = useState(0);

  // Same phased open/close as PopupMenu: keep the card visually present
  // during the exit transition by deferring the actual store-level close
  // (setResult → setHeaderOmnibox(null)) until the fade-out finishes.
  const [phase, setPhase] = useState<'enter' | 'open' | 'exit'>('enter');
  useLayoutEffect(() => {
    if (!omni) return;
    setPhase('enter');
    const id = requestAnimationFrame(() => setPhase('open'));
    return () => cancelAnimationFrame(id);
  }, [omni?.id]);

  const closeWith = useCallback(
    (pickedUrl: string | null) => {
      if (!omni) return;
      setPhase('exit');
      const omniId = omni.id;
      setTimeout(() => setResult({ id: omniId, pickedUrl }), FADE_MS);
    },
    [omni, setResult],
  );

  // Reset local input each time a new request arrives.
  useEffect(() => {
    if (!omni) return;
    setAddr(omni.initialValue);
    setHighlight(0);
    // Defer focus a frame so the input has mounted.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
  }, [omni?.id]);

  // Esc dismisses without picking.
  useEffect(() => {
    if (!omni) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeWith(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [omni, closeWith]);

  // Filter suggestions identically to EmptyBrowserState.
  const { rows, total } = useMemo(() => {
    type Row =
      | { kind: 'service'; service: Service }
      | { kind: 'recent'; entry: { url: string; visitedAt: number } };
    const services = omni?.services ?? null;
    const history = omni?.history ?? [];
    const liveUrls = new Set((services ?? []).map((s) => s.url));
    const recents = history.filter((h) => !liveUrls.has(h.url));
    const query = addr.trim().toLowerCase();
    const matches = (text: string) => !query || text.toLowerCase().includes(query);
    const filteredServices = (services ?? []).filter(
      (s) => matches(s.url) || matches(s.cmd) || matches(`${displayHost(s.host)}:${s.port}`),
    );
    const filteredRecents = recents.filter((h) => matches(h.url));
    const rows: Row[] = [
      ...filteredServices.map((s): Row => ({ kind: 'service', service: s })),
      ...filteredRecents.map((e): Row => ({ kind: 'recent', entry: e })),
    ];
    return { rows, total: rows.length };
  }, [omni?.services, omni?.history, addr]);

  useEffect(() => {
    if (highlight >= total && total > 0) setHighlight(total - 1);
    if (total === 0) setHighlight(0);
  }, [total, highlight]);

  if (!omni) return null;

  const choose = (idx: number) => {
    const row = rows[idx];
    if (!row) return;
    closeWith(row.kind === 'service' ? row.service.url : row.entry.url);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (total > 0 && highlight >= 0 && highlight < total) {
      choose(highlight);
      return;
    }
    const url = normalizeAddr(addr);
    if (url) closeWith(url);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && total > 0) {
      e.preventDefault();
      setHighlight((h) => (h + 1) % total);
    } else if (e.key === 'ArrowUp' && total > 0) {
      e.preventDefault();
      setHighlight((h) => (h - 1 + total) % total);
    }
  };

  const services = omni.services;
  const query = addr.trim();
  const visible = phase === 'open';

  return (
    <>
      {/* Backdrop catches outside clicks. Near-opaque enough that macOS
          routes the click to the overlay WebContentsView (same rule we
          worked out for PopupMenu). */}
      <Box
        position="fixed"
        inset={0}
        zIndex={4999}
        style={{
          background: 'rgba(0,0,0,0.4)',
          pointerEvents: 'auto',
          opacity: visible ? 1 : 0,
          transition: `opacity ${FADE_MS}ms ease`,
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          closeWith(null);
        }}
      />
      {/* Anchored card: positioned over the page header URL bar so it
          visually replaces the underlying input (which the user clicked)
          while showing the attached suggestion list. */}
      <Box
        position="fixed"
        top={`${omni.anchor.y}px`}
        left={`${omni.anchor.x}px`}
        width={`${omni.anchor.width}px`}
        zIndex={5000}
        bg="#0d1117"
        border="1px solid #1f6feb"
        borderRadius="14px"
        boxShadow="0 0 0 2px rgba(31,111,235,0.35), 0 12px 32px rgba(0,0,0,0.45)"
        overflow="hidden"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0) scale(1)' : 'translateY(-4px) scale(0.99)',
          transformOrigin: 'top left',
          transition: `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease`,
        }}
      >
        <Box as="form" onSubmit={onSubmit}>
          <Input
            ref={inputRef}
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="http://127.0.0.1:5173"
            fontSize="12px"
            bg="transparent"
            color="#f0f6fc"
            border="none"
            borderRadius="0"
            px="3"
            h="28px"
            spellCheck={false}
            autoComplete="off"
            _focus={{ boxShadow: 'none', outline: 'none' }}
            _focusVisible={{ boxShadow: 'none', outline: 'none' }}
          />
        </Box>
        <Box
          maxH="320px"
          overflowY="auto"
          borderTop={total > 0 || query || services === null ? '1px solid #21262d' : 'none'}
        >
          {services === null ? (
            <Flex h="64px" align="center" justify="center">
              <SquareLoader />
            </Flex>
          ) : total === 0 ? (
            query ? (
              <Box px="3" py="2">
                <Text fontSize="12px" color="#7d8590">
                  No matches for "{addr}". Press Enter to load this URL.
                </Text>
              </Box>
            ) : null
          ) : (
            rows.map((row, idx) => {
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
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(idx)}
                    borderBottom={idx < rows.length - 1 ? '1px solid #161b22' : undefined}
                  >
                    <HStack gap="2" align="baseline">
                      <Text fontFamily="var(--grove-mono)" fontSize="12px" color="#79c0ff">
                        {displayHost(s.host)}:{s.port}
                      </Text>
                      <Text fontSize="11px" color="#c9d1d9">
                        {s.cmd}
                      </Text>
                      <Text fontSize="10px" color="#7d8590">
                        pid {s.pid}
                      </Text>
                    </HStack>
                  </Box>
                );
              }
              const h = row.entry;
              return (
                <Box
                  key={`r:${h.url}`}
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
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(idx)}
                  borderBottom={idx < rows.length - 1 ? '1px solid #161b22' : undefined}
                >
                  <Text fontFamily="var(--grove-mono)" fontSize="12px" color="#c9d1d9">
                    {h.url}
                  </Text>
                </Box>
              );
            })
          )}
        </Box>
      </Box>
    </>
  );
}
