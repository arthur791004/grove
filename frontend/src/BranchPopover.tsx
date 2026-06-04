// Hover popover for the branch chip in ChipStrip. Lists local branches
// for the workspace's repo, surfaces ahead/behind counts, and exposes
// the three actions a user usually wants from this affordance: pull
// latest on the current branch, switch to a sibling, and delete a stale
// one.
//
// Trigger: wrap the branch chip in <BranchPopoverTrigger cwd=…>. Hover
// opens after a short delay; leaving the trigger and the popover both
// schedules a close (grace period so the cursor can travel from chip to
// popover without dismissing).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Flex, HStack, Text } from '@chakra-ui/react';
import { API_BASE } from './api';
import { BranchIcon } from './icons';
import { SquareLoader } from './SquareLoader';

interface BranchInfo {
  name: string;
  current: boolean;
  ahead: number;
  behind: number;
  upstream: string | null;
}

const OPEN_DELAY_MS = 220;
const CLOSE_DELAY_MS = 180;

export function BranchPopoverTrigger({
  cwd,
  children,
}: {
  cwd: string;
  children: React.ReactNode;
}) {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<
    | {
        left: number;
        top?: number;
        bottom?: number;
        maxHeight: number;
        placement: 'below' | 'above';
      }
    | null
  >(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearTimers = () => {
    if (openTimer.current != null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleOpen = () => {
    clearTimers();
    openTimer.current = window.setTimeout(() => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) {
        const GAP = 6;
        const MARGIN = 8;
        const vh = window.innerHeight;
        const spaceBelow = vh - r.bottom - GAP - MARGIN;
        const spaceAbove = r.top - GAP - MARGIN;
        const desired = Math.min(vh * 0.6, 480);
        const flip = spaceBelow < Math.min(desired, 200) && spaceAbove > spaceBelow;
        if (flip) {
          setAnchor({
            left: r.left,
            bottom: vh - r.top + GAP,
            maxHeight: Math.max(120, spaceAbove),
            placement: 'above',
          });
        } else {
          setAnchor({
            left: r.left,
            top: r.bottom + GAP,
            maxHeight: Math.max(120, spaceBelow),
            placement: 'below',
          });
        }
      }
      setOpen(true);
    }, OPEN_DELAY_MS);
  };
  const scheduleClose = () => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => () => clearTimers(), []);

  return (
    <>
      <Box
        ref={triggerRef}
        display="inline-flex"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
      >
        {children}
      </Box>
      {open && anchor && (
        <BranchPopover
          cwd={cwd}
          anchor={anchor}
          onMouseEnter={clearTimers}
          onMouseLeave={scheduleClose}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function BranchPopover({
  cwd,
  anchor,
  onMouseEnter,
  onMouseLeave,
  onClose,
}: {
  cwd: string;
  anchor: {
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
    placement: 'below' | 'above';
  };
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClose: () => void;
}) {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "<action>:<branch>" — disables that row's buttons
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/git/branches?cwd=${encodeURIComponent(cwd)}`);
      if (!r.ok) {
        setError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as { branches: BranchInfo[] };
      setBranches(data.branches);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (action: 'pull' | 'switch' | 'delete', branch?: string) => {
    setActionError(null);
    setBusy(`${action}:${branch ?? '*'}`);
    try {
      const r = await fetch(`${API_BASE}/git/branch-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, action, branch }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setActionError(j.error ?? `HTTP ${r.status}`);
      } else {
        await load();
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box
      position="fixed"
      top={anchor.top != null ? `${anchor.top}px` : undefined}
      bottom={anchor.bottom != null ? `${anchor.bottom}px` : undefined}
      left={`${anchor.left}px`}
      bg="#0d1117"
      border="1px solid #30363d"
      borderRadius="8px"
      boxShadow="0 12px 32px rgba(0,0,0,0.5)"
      width="320px"
      maxH={`${anchor.maxHeight}px`}
      overflow="hidden"
      zIndex={1500}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      display="flex"
      flexDirection="column"
    >
      <Flex
        align="center"
        justify="space-between"
        px="3"
        py="2"
        borderBottom="1px solid #21262d"
      >
        <HStack gap="2">
          <BranchIcon size={12} />
          <Text fontSize="11px" color="#c9d1d9" fontFamily="var(--grove-mono), monospace">
            branches
          </Text>
        </HStack>
        <Box
          as="button"
          fontSize="11px"
          px="2"
          py="1"
          bg={busy === 'pull:*' ? '#21262d' : 'transparent'}
          color="#c9d1d9"
          border="1px solid #30363d"
          borderRadius="4px"
          cursor={busy === 'pull:*' ? 'wait' : 'pointer'}
          _hover={{ bg: '#21262d' }}
          onClick={() => {
            if (busy === 'pull:*') return;
            void runAction('pull');
          }}
          aria-disabled={busy === 'pull:*' || undefined}
          title="git pull --ff-only on the current branch"
        >
          {busy === 'pull:*' ? 'Pulling…' : 'Pull latest'}
        </Box>
      </Flex>
      <Box flex="1" overflowY="auto">
        {error ? (
          <Box px="3" py="3">
            <Text fontSize="11px" color="#f85149">
              {error}
            </Text>
          </Box>
        ) : branches === null ? (
          <Flex h="64px" align="center" justify="center">
            <SquareLoader />
          </Flex>
        ) : branches.length === 0 ? (
          <Box px="3" py="3">
            <Text fontSize="11px" color="#7d8590">
              No local branches.
            </Text>
          </Box>
        ) : (
          branches.map((b) => (
            <BranchRow
              key={b.name}
              branch={b}
              busy={busy}
              onSwitch={() => void runAction('switch', b.name)}
              onDelete={() => {
                if (window.confirm(`Delete local branch '${b.name}'?`)) {
                  void runAction('delete', b.name);
                }
              }}
            />
          ))
        )}
      </Box>
      {actionError && (
        <Box borderTop="1px solid #21262d" px="3" py="2">
          <Text fontSize="11px" color="#f85149" fontFamily="var(--grove-mono), monospace">
            {actionError}
          </Text>
          <Box
            as="button"
            mt="1"
            fontSize="10px"
            color="#7d8590"
            bg="transparent"
            border="none"
            cursor="pointer"
            _hover={{ color: '#c9d1d9' }}
            onClick={() => setActionError(null)}
          >
            dismiss
          </Box>
        </Box>
      )}
      <Box
        borderTop="1px solid #21262d"
        px="3"
        py="2"
        display="flex"
        justifyContent="flex-end"
      >
        <Box
          as="button"
          fontSize="10px"
          color="#7d8590"
          bg="transparent"
          border="none"
          cursor="pointer"
          _hover={{ color: '#c9d1d9' }}
          onClick={onClose}
        >
          close
        </Box>
      </Box>
    </Box>
  );
}

function BranchRow({
  branch,
  busy,
  onSwitch,
  onDelete,
}: {
  branch: BranchInfo;
  busy: string | null;
  onSwitch: () => void;
  onDelete: () => void;
}) {
  const switching = busy === `switch:${branch.name}`;
  const deleting = busy === `delete:${branch.name}`;
  const disabled = busy !== null;
  return (
    <Flex
      align="center"
      px="3"
      py="2"
      gap="2"
      borderBottom="1px solid #161b22"
      bg={branch.current ? '#161b22' : 'transparent'}
      _hover={branch.current ? { bg: '#161b22' } : { bg: '#161b22' }}
    >
      <Box flex="1" minW="0">
        <HStack gap="2" align="baseline">
          <Text
            fontSize="12px"
            color={branch.current ? '#7ee787' : '#c9d1d9'}
            fontFamily="var(--grove-mono), monospace"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
          >
            {branch.current ? '* ' : ''}
            {branch.name}
          </Text>
          {(branch.ahead > 0 || branch.behind > 0) && (
            <Text fontSize="10px" color="#7d8590" fontFamily="var(--grove-mono), monospace">
              {branch.behind > 0 && `↓${branch.behind}`}
              {branch.behind > 0 && branch.ahead > 0 && ' '}
              {branch.ahead > 0 && `↑${branch.ahead}`}
            </Text>
          )}
        </HStack>
      </Box>
      {!branch.current && (
        <>
          <Box
            as="button"
            fontSize="10px"
            px="2"
            py="1"
            bg="transparent"
            color="#c9d1d9"
            border="1px solid #30363d"
            borderRadius="4px"
            cursor={disabled ? 'wait' : 'pointer'}
            _hover={{ bg: '#21262d' }}
            onClick={() => {
              if (disabled) return;
              onSwitch();
            }}
            aria-disabled={disabled || undefined}
            title={`Switch to ${branch.name}`}
          >
            {switching ? '…' : 'Switch'}
          </Box>
          <Box
            as="button"
            fontSize="10px"
            px="2"
            py="1"
            bg="transparent"
            color="#f85149"
            border="1px solid #30363d"
            borderRadius="4px"
            cursor={disabled ? 'wait' : 'pointer'}
            _hover={{ bg: '#21262d' }}
            onClick={() => {
              if (disabled) return;
              onDelete();
            }}
            aria-disabled={disabled || undefined}
            title={`Delete ${branch.name}`}
          >
            {deleting ? '…' : 'Delete'}
          </Box>
        </>
      )}
    </Flex>
  );
}
