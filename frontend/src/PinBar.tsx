import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Flex, Portal, Text } from '@chakra-ui/react';
import { useStore, type Pin } from './store';
import { sendSessionInput } from './api';
import { Tooltip } from './Tooltip';
import { PinManagerModal, type ManagerState } from './PinManagerModal';
import { ClaudeIcon, PlusIcon, TerminalIcon } from './icons';

const PIN_LABEL_MAX = 20;
// Reserve room when deciding how many chips fit: the `[+]` button, a possible
// `…` overflow button (both in the fixed right cluster), and the strip's own
// px="6" left+right padding, which `barWidth` (clientWidth) still includes.
const RIGHT_CLUSTER_RESERVE = 104;
const CHIP_GAP = 6;

// Sends a pin's command to the active tab's pty. Claude runs as a TUI inside
// the pty, so shell and Claude pins dispatch identically — the only
// difference is the `mismatch` signal when a shell pin lands on a Claude tab
// (Claude receives it as a chat message, not a command).
export function executePin(pin: Pin): 'ok' | 'no-tab' | 'mismatch' {
  const s = useStore.getState();
  const tabId = s.activeTabId;
  if (!tabId) return 'no-tab';
  void sendSessionInput(tabId, pin.command + '\r');
  const isClaudeTab = s.agentStates[tabId] !== undefined;
  return isClaudeTab && pin.type === 'shell' ? 'mismatch' : 'ok';
}

// The pin strip is pinned to the bottom of each tab's TerminalView, below the
// shell input section and outside the raw-mode xterm overlay — so action chips
// stay clickable on Claude tabs too. `active` gates draft consumption: every
// mounted tab renders its own PinBar, but only the visible one should react to
// a pending "Pin this command" draft. Memoized so a TerminalView frame doesn't
// reconcile the whole strip.
export const PinBar = memo(function PinBar({
  tabId,
  active,
}: {
  tabId: string;
  active: boolean;
}) {
  const pins = useStore((s) => s.pins);
  const activeGroupId = useStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.groupId ?? null,
  );
  const pendingPinDraft = useStore((s) => s.pendingPinDraft);
  const setPendingPinDraft = useStore((s) => s.setPendingPinDraft);

  const [manager, setManager] = useState<ManagerState>({ mode: 'closed' });
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [warnedPinId, setWarnedPinId] = useState<string | null>(null);

  // "Pin this command" (and similar) hand a draft off through the store.
  // Consume it here: open the manager straight in the add form, then clear so
  // it can't re-open on the next render. Only the active tab's strip consumes.
  useEffect(() => {
    if (active && pendingPinDraft) {
      setManager({ mode: 'add', draft: pendingPinDraft });
      setPendingPinDraft(null);
    }
  }, [active, pendingPinDraft, setPendingPinDraft]);

  // The modal is portaled, so it would outlive its owning tab going inactive
  // (e.g. the user switches tabs with it open) — close it when that happens.
  useEffect(() => {
    if (!active) setManager((m) => (m.mode === 'closed' ? m : { mode: 'closed' }));
  }, [active]);

  // Hidden pins stay out of the strip; they remain listed in the manager.
  const ordered = useMemo(() => {
    const global = pins.filter((p) => p.scope === 'global' && !p.hidden);
    const ws = pins.filter(
      (p) => p.scope === 'workspace' && p.groupId === activeGroupId && !p.hidden,
    );
    return [...global, ...ws];
  }, [pins, activeGroupId]);

  const barRef = useRef<HTMLDivElement>(null);
  const measureRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [barWidth, setBarWidth] = useState(0);
  const [visibleCount, setVisibleCount] = useState(ordered.length);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBarWidth(el.clientWidth));
    ro.observe(el);
    setBarWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (barWidth === 0) return;
    let used = 0;
    let count = 0;
    for (let i = 0; i < ordered.length; i++) {
      const w = measureRefs.current[i]?.offsetWidth ?? 0;
      used += w + CHIP_GAP;
      if (used > barWidth - RIGHT_CLUSTER_RESERVE) break;
      count++;
    }
    setVisibleCount(count);
  }, [barWidth, ordered]);

  const visible = ordered.slice(0, visibleCount);
  const overflow = ordered.slice(visibleCount);

  const run = (pin: Pin) => {
    if (executePin(pin) === 'mismatch') {
      setWarnedPinId(pin.id);
      window.setTimeout(() => setWarnedPinId((cur) => (cur === pin.id ? null : cur)), 700);
    }
    setOverflowOpen(false);
  };

  return (
    // pb matches the gap above the strip (composer card's mb) so the chips
    // sit with equal breathing room to the input section and the window edge.
    <Box flexShrink={0} bg="#010409" pb="2">
      <PinManagerModal state={manager} setState={setManager} activeGroupId={activeGroupId} />
      {/* Hidden measurement row — chips at their natural width so the overflow
          math sees real sizes even for chips currently in the popover. */}
      <Box position="absolute" visibility="hidden" pointerEvents="none" left="-9999px">
        <Flex gap={`${CHIP_GAP}px`}>
          {ordered.map((pin, i) => (
            <Box
              key={pin.id}
              ref={(el: HTMLDivElement | null) => {
                measureRefs.current[i] = el;
              }}
            >
              <PinChip pin={pin} disabled={false} warned={false} onRun={() => {}} />
            </Box>
          ))}
        </Flex>
      </Box>
      <Flex
        ref={barRef}
        align="center"
        justify="center"
        gap={`${CHIP_GAP}px`}
        px="6"
        h="34px"
        overflow="hidden"
      >
        {ordered.length === 0 ? (
          <Text
            fontSize="11px"
            color="#7d8590"
            cursor="pointer"
            onClick={() => setManager({ mode: 'list' })}
            _hover={{ color: '#c9d1d9' }}
          >
            {pins.length === 0 ? 'Add your first pin →' : 'All pins hidden — manage →'}
          </Text>
        ) : (
          visible.map((pin, idx) => {
            const prev = visible[idx - 1];
            return (
              <Fragment key={pin.id}>
                {prev?.scope === 'global' && pin.scope === 'workspace' && (
                  <Box w="1px" h="14px" bg="#21262d" flexShrink={0} mx="1" />
                )}
                <PinChip
                  pin={pin}
                  disabled={false}
                  warned={warnedPinId === pin.id}
                  shortcut={idx < 9 ? `⌘⇧${idx + 1}` : undefined}
                  onRun={() => run(pin)}
                  onEdit={() => setManager({ mode: 'edit', pin })}
                />
              </Fragment>
            );
          })
        )}
        {overflow.length > 0 && (
          <OverflowPopover
            pins={overflow}
            startIndex={visibleCount}
            open={overflowOpen}
            disabled={false}
            onToggle={() => setOverflowOpen((v) => !v)}
            onClose={() => setOverflowOpen(false)}
            onRun={run}
            onEdit={(pin) => setManager({ mode: 'edit', pin })}
          />
        )}
        <RightClusterButton title="Manage pins" onClick={() => setManager({ mode: 'list' })}>
          <PlusIcon size={12} />
        </RightClusterButton>
      </Flex>
    </Box>
  );
});

function RightClusterButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={title}>
      <Box
        as="button"
        onClick={onClick}
        flexShrink={0}
        w="22px"
        h="22px"
        borderRadius="5px"
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
        color="#7d8590"
        bg="transparent"
        cursor="pointer"
        _hover={{ bg: '#21262d', color: '#c9d1d9' }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

function PinChip({
  pin,
  disabled,
  warned,
  shortcut,
  onRun,
  onEdit,
}: {
  pin: Pin;
  disabled: boolean;
  warned: boolean;
  shortcut?: string;
  onRun: () => void;
  onEdit?: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const truncated = pin.label.length > PIN_LABEL_MAX;
  const shown = truncated ? pin.label.slice(0, PIN_LABEL_MAX - 1) + '…' : pin.label;
  const Icon = pin.type === 'claude' ? ClaudeIcon : TerminalIcon;
  const tip = shortcut ? `${pin.label}  ·  ${shortcut}` : pin.label;

  const chip = (
    <Flex
      as="button"
      align="center"
      gap="1.5"
      flexShrink={0}
      h="22px"
      px="2"
      borderRadius="5px"
      // A pin label is a single chip — never let it wrap to a second line
      // (the overflow popover is narrow enough to trigger it otherwise).
      whiteSpace="nowrap"
      // Borderless by default; the transparent 1px keeps the box size stable
      // so the chip doesn't jitter when the warned border briefly appears.
      border="1px solid"
      borderColor={warned ? '#d29922' : 'transparent'}
      bg={warned ? '#d2992222' : '#0d1117'}
      color={disabled ? '#484f58' : '#c9d1d9'}
      fontSize="12px"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.4 : 1}
      _hover={disabled ? undefined : { bg: '#21262d' }}
      onClick={() => {
        if (!disabled) onRun();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <Box as="span" display="inline-flex" color={pin.type === 'claude' ? '#a371f7' : '#7d8590'}>
        <Icon size={12} />
      </Box>
      <Box as="span">{shown}</Box>
    </Flex>
  );

  return (
    <>
      {truncated || shortcut ? <Tooltip label={tip}>{chip}</Tooltip> : chip}
      {menu && (
        <PinContextMenu
          pin={pin}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onEdit={onEdit}
        />
      )}
    </>
  );
}

function OverflowPopover({
  pins,
  startIndex,
  open,
  disabled,
  onToggle,
  onClose,
  onRun,
  onEdit,
}: {
  pins: Pin[];
  startIndex: number;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRun: (pin: Pin) => void;
  onEdit: (pin: Pin) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Anchored by its RIGHT edge: the `…` trigger lives in the strip's right
  // cluster, so a left-anchored menu would overflow the viewport on narrow
  // layouts. `right` is the gap from the window's right edge to the trigger's.
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect)
      setPos({
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.top + 6,
      });
    const onDoc = (e: PointerEvent) => {
      if (!triggerRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [open, onClose]);

  return (
    <>
      <Tooltip label={`${pins.length} more`}>
        <Box
          as="button"
          ref={triggerRef}
          onClick={onToggle}
          flexShrink={0}
          w="22px"
          h="22px"
          borderRadius="5px"
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          color="#7d8590"
          bg={open ? '#21262d' : 'transparent'}
          cursor="pointer"
          fontSize="13px"
          _hover={{ bg: '#21262d', color: '#c9d1d9' }}
        >
          …
        </Box>
      </Tooltip>
      {open && pos && (
        <Portal>
          <Flex
            position="fixed"
            right={`${pos.right}px`}
            bottom={`${pos.bottom}px`}
            direction="column"
            gap="1"
            bg="#161b22"
            border="1px solid #30363d"
            borderRadius="6px"
            p="1.5"
            boxShadow="0 8px 24px rgba(0,0,0,0.5)"
            zIndex={1000}
            // Cap to the viewport so a long pin label can't push the menu off
            // the left edge on a narrow (mobile) layout.
            maxW="min(280px, calc(100vw - 16px))"
          >
            {pins.map((pin, i) => (
              <PinChip
                key={pin.id}
                pin={pin}
                disabled={disabled}
                warned={false}
                shortcut={startIndex + i < 9 ? `⌘⇧${startIndex + i + 1}` : undefined}
                onRun={() => onRun(pin)}
                onEdit={() => onEdit(pin)}
              />
            ))}
          </Flex>
        </Portal>
      )}
    </>
  );
}

function PinContextMenu({
  pin,
  x,
  y,
  onClose,
  onEdit,
}: {
  pin: Pin;
  x: number;
  y: number;
  onClose: () => void;
  onEdit?: () => void;
}) {
  const removePin = useStore((s) => s.removePin);
  const movePin = useStore((s) => s.movePin);
  const updatePin = useStore((s) => s.updatePin);
  const addPin = useStore((s) => s.addPin);
  const activeGroupId = useStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.groupId ?? null,
  );

  useEffect(() => {
    const onDoc = () => onClose();
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onDoc);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onDoc);
    };
  }, [onClose]);

  const items: Array<{ label: string; onClick: () => void; disabled?: boolean }> = [
    { label: 'Edit', onClick: () => onEdit?.(), disabled: !onEdit },
    { label: 'Move up', onClick: () => movePin(pin.id, -1) },
    { label: 'Move down', onClick: () => movePin(pin.id, 1) },
    {
      label: 'Duplicate',
      onClick: () => addPin({ ...pin, label: `${pin.label} copy` }),
    },
    pin.scope === 'workspace'
      ? {
          label: 'Make global',
          onClick: () => updatePin(pin.id, { scope: 'global', groupId: undefined }),
        }
      : {
          label: 'Move to this workspace',
          onClick: () => updatePin(pin.id, { scope: 'workspace', groupId: activeGroupId! }),
          disabled: !activeGroupId,
        },
    { label: 'Remove', onClick: () => removePin(pin.id) },
  ];

  return (
    <Portal>
      <Box
        position="fixed"
        left={`${x}px`}
        top={`${y}px`}
        bg="#161b22"
        border="1px solid #30363d"
        borderRadius="6px"
        py="1"
        minW="180px"
        boxShadow="0 10px 30px rgba(0,0,0,0.5)"
        zIndex={1100}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <Box
            key={item.label}
            px="3"
            py="1.5"
            fontSize="12px"
            color={item.disabled ? '#484f58' : item.label === 'Remove' ? '#f85149' : '#c9d1d9'}
            cursor={item.disabled ? 'not-allowed' : 'pointer'}
            _hover={item.disabled ? undefined : { bg: '#21262d' }}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
          >
            {item.label}
          </Box>
        ))}
      </Box>
    </Portal>
  );
}
