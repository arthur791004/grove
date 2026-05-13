import { useEffect, useRef, useState } from 'react';
import { Box, Text } from '@chakra-ui/react';
import { useStore } from './store';
import { TerminalView } from './TerminalView';

export function Workspace() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);

  // Lazy-mount: a TerminalView only mounts (and thus spawns a backend pty)
  // the first time its tab becomes active. Persisted tabs that the user
  // never re-opens cost zero ptys until clicked — important because macOS
  // caps total ptys around kern.tty.ptmx_max (~127) and the backend
  // separately enforces GROVE_MAX_PTY_SESSIONS.
  const [mounted, setMounted] = useState<Set<string>>(() =>
    activeTabId ? new Set([activeTabId]) : new Set(),
  );
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  useEffect(() => {
    if (!activeTabId) return;
    if (mountedRef.current.has(activeTabId)) return;
    setMounted((prev) => {
      if (prev.has(activeTabId)) return prev;
      const next = new Set(prev);
      next.add(activeTabId);
      return next;
    });
  }, [activeTabId]);

  if (tabs.length === 0) {
    return (
      <Box display="flex" alignItems="center" justifyContent="center" h="100%">
        <Text color="#7d8590" fontSize="sm">
          No tabs. Press ⌘T to create one.
        </Text>
      </Box>
    );
  }

  return (
    <Box position="relative" w="100%" h="100%" bg="#010409">
      {tabs.filter((t) => mounted.has(t.id)).map((t) => (
        <Box
          key={t.id}
          position="absolute"
          inset="0"
          display={t.id === activeTabId ? 'block' : 'none'}
        >
          <TerminalView tabId={t.id} active={t.id === activeTabId} />
        </Box>
      ))}
    </Box>
  );
}
