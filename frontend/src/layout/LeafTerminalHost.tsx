// Renders all terminal-backed panes (shell / claude) for a single leaf,
// showing only the leaf's active pane. Replaces the App-level <Workspace />
// for in-leaf rendering so multiple leaves can each show a different
// terminal — required once cross-leaf drag lets a user move a terminal pane
// into a previously-panel leaf.
//
// Lazy-mount: a TerminalView only mounts the first time its pane becomes
// the leaf's active pane. Persisted panes the user never re-opens cost
// zero PTYs until clicked.

import { useEffect, useRef, useState } from 'react';
import { Box } from '@chakra-ui/react';
import { TerminalView } from '../TerminalView';
import type { LeafNode } from './types';

export function LeafTerminalHost({ leaf }: { leaf: LeafNode }) {
  const terminalPanes = leaf.panes.filter((p) => p.kind === 'shell' || p.kind === 'claude');
  const activeId = leaf.activePaneId;

  const [mounted, setMounted] = useState<Set<string>>(() =>
    activeId && terminalPanes.some((p) => p.id === activeId) ? new Set([activeId]) : new Set(),
  );
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  useEffect(() => {
    if (!activeId) return;
    if (mountedRef.current.has(activeId)) return;
    if (!terminalPanes.some((p) => p.id === activeId)) return;
    setMounted((prev) => {
      if (prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.add(activeId);
      return next;
    });
  }, [activeId, terminalPanes]);

  return (
    <Box position="absolute" inset="0" bg="#010409">
      {terminalPanes
        .filter((p) => mounted.has(p.id))
        .map((p) => (
          <Box
            key={p.id}
            position="absolute"
            inset="0"
            display={p.id === activeId ? 'block' : 'none'}
          >
            <TerminalView tabId={p.id} active={p.id === activeId} />
          </Box>
        ))}
    </Box>
  );
}
