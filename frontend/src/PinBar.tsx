import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Flex, Input, Portal, SegmentGroup, Text } from '@chakra-ui/react';
import { useStore, type Pin, type PinScope, type PinType } from './store';
import { sendSessionInput } from './api';
import { Tooltip } from './Tooltip';
import { ClaudeIcon, CloseIcon, PlusIcon, TerminalIcon } from './icons';

const PIN_LABEL_MAX = 20;
// Reserve room for the `[+]` button and a possible `…` overflow button when
// deciding how many chips fit — both live in the fixed right cluster.
const RIGHT_CLUSTER_RESERVE = 78;
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

type EditorState =
  | { mode: 'closed' }
  | { mode: 'add'; draft?: Omit<Pin, 'id'> }
  | { mode: 'edit'; pin: Pin };

export function PinBar() {
  const pins = useStore((s) => s.pins);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeGroupId = useStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.groupId ?? null,
  );
  const pendingPinDraft = useStore((s) => s.pendingPinDraft);
  const setPendingPinDraft = useStore((s) => s.setPendingPinDraft);

  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [warnedPinId, setWarnedPinId] = useState<string | null>(null);

  // "Pin this command" (and similar) hand a draft off through the store.
  // Consume it here: open the editor pre-filled, then clear so it can't
  // re-open on the next render.
  useEffect(() => {
    if (pendingPinDraft) {
      setEditor({ mode: 'add', draft: pendingPinDraft });
      setPendingPinDraft(null);
    }
  }, [pendingPinDraft, setPendingPinDraft]);

  const ordered = useMemo(() => {
    const global = pins.filter((p) => p.scope === 'global');
    const ws = pins.filter((p) => p.scope === 'workspace' && p.groupId === activeGroupId);
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
    <Box flexShrink={0} borderTop="1px solid #21262d" bg="#0d1117">
      {editor.mode !== 'closed' && (
        <PinEditor
          state={editor}
          activeGroupId={activeGroupId}
          onClose={() => setEditor({ mode: 'closed' })}
        />
      )}
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
      <Flex ref={barRef} align="center" gap={`${CHIP_GAP}px`} px="2" h="34px" overflow="hidden">
        {ordered.length === 0 ? (
          <Text
            fontSize="11px"
            color="#7d8590"
            cursor="pointer"
            onClick={() => setEditor({ mode: 'add' })}
            _hover={{ color: '#c9d1d9' }}
          >
            Add your first pin →
          </Text>
        ) : (
          visible.map((pin, idx) => {
            const prev = visible[idx - 1];
            return (
              <Fragment key={pin.id}>
                {prev?.scope === 'global' && pin.scope === 'workspace' && (
                  <Box w="1px" h="16px" bg="#30363d" flexShrink={0} mx="1" />
                )}
                <PinChip
                  pin={pin}
                  disabled={!activeTabId}
                  warned={warnedPinId === pin.id}
                  shortcut={idx < 9 ? `⌘⇧${idx + 1}` : undefined}
                  onRun={() => run(pin)}
                  onEdit={() => setEditor({ mode: 'edit', pin })}
                />
              </Fragment>
            );
          })
        )}
        <Box flex="1" />
        {overflow.length > 0 && (
          <OverflowPopover
            pins={overflow}
            startIndex={visibleCount}
            open={overflowOpen}
            disabled={!activeTabId}
            onToggle={() => setOverflowOpen((v) => !v)}
            onClose={() => setOverflowOpen(false)}
            onRun={run}
            onEdit={(pin) => setEditor({ mode: 'edit', pin })}
          />
        )}
        <RightClusterButton title="Add pin" onClick={() => setEditor({ mode: 'add' })}>
          <PlusIcon size={12} />
        </RightClusterButton>
      </Flex>
    </Box>
  );
}

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
        w="24px"
        h="24px"
        borderRadius="4px"
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
      h="24px"
      px="2"
      borderRadius="4px"
      border="1px solid"
      borderColor={warned ? '#d29922' : '#30363d'}
      bg={warned ? '#d2992222' : '#161b22'}
      color={disabled ? '#484f58' : '#c9d1d9'}
      fontSize="11px"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.4 : 1}
      _hover={disabled ? undefined : { bg: '#21262d', borderColor: '#484f58' }}
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
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
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
          w="24px"
          h="24px"
          borderRadius="4px"
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
            left={`${pos.left}px`}
            bottom={`${pos.bottom}px`}
            direction="column"
            gap="1"
            bg="#161b22"
            border="1px solid #30363d"
            borderRadius="6px"
            p="1.5"
            boxShadow="0 8px 24px rgba(0,0,0,0.5)"
            zIndex={1000}
            maxW="280px"
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

function PinEditor({
  state,
  activeGroupId,
  onClose,
}: {
  state: Exclude<EditorState, { mode: 'closed' }>;
  activeGroupId: string | null;
  onClose: () => void;
}) {
  const addPin = useStore((s) => s.addPin);
  const updatePin = useStore((s) => s.updatePin);

  const seed = state.mode === 'edit' ? state.pin : state.draft;
  const [label, setLabel] = useState(seed?.label ?? '');
  const [type, setType] = useState<PinType>(seed?.type ?? 'shell');
  const [command, setCommand] = useState(seed?.command ?? '');
  const [scope, setScope] = useState<PinScope>(
    seed?.scope === 'workspace' && activeGroupId ? 'workspace' : (seed?.scope ?? 'global'),
  );

  const canSave = label.trim().length > 0 && command.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    const fields = {
      label: label.trim(),
      type,
      command: command.trim(),
      scope,
      groupId: scope === 'workspace' ? (activeGroupId ?? undefined) : undefined,
    };
    if (state.mode === 'edit') updatePin(state.pin.id, fields);
    else addPin(fields);
    onClose();
  };

  return (
    <Box borderBottom="1px solid #21262d" bg="#161b22" px="3" py="2.5">
      <Flex align="center" justify="space-between" mb="2">
        <Text fontSize="12px" fontWeight="600" color="#f0f6fc">
          {state.mode === 'edit' ? 'Edit pin' : 'New pin'}
        </Text>
        <Box as="button" onClick={onClose} color="#7d8590" _hover={{ color: '#c9d1d9' }}>
          <CloseIcon size={10} />
        </Box>
      </Flex>
      <Flex direction="column" gap="2">
        <EditorRow label="Label">
          <Input
            size="xs"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="run tests"
            autoFocus
            bg="#0d1117"
            border="1px solid #30363d"
            color="#c9d1d9"
            fontSize="12px"
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') onClose();
            }}
          />
        </EditorRow>
        <EditorRow label="Type">
          <SegmentGroup.Root
            size="sm"
            value={type}
            onValueChange={(e) => {
              if (e.value) setType(e.value as PinType);
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
        </EditorRow>
        <EditorRow label="Command">
          <Input
            size="xs"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={type === 'claude' ? 'explain the last error' : 'npm test'}
            bg="#0d1117"
            border="1px solid #30363d"
            color="#c9d1d9"
            fontSize="12px"
            fontFamily="var(--grove-mono)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') onClose();
            }}
          />
        </EditorRow>
        <EditorRow label="Scope">
          <SegmentGroup.Root
            size="sm"
            value={scope}
            onValueChange={(e) => {
              if (e.value && (e.value === 'global' || activeGroupId)) {
                setScope(e.value as PinScope);
              }
            }}
          >
            <SegmentGroup.Indicator />
            <SegmentGroup.Items
              items={[
                { value: 'global', label: 'Global' },
                { value: 'workspace', label: 'This workspace', disabled: !activeGroupId },
              ]}
            />
          </SegmentGroup.Root>
        </EditorRow>
        <Flex justify="flex-end" gap="2" mt="0.5">
          <EditorButton onClick={onClose}>Cancel</EditorButton>
          <EditorButton primary disabled={!canSave} onClick={save}>
            {state.mode === 'edit' ? 'Save' : 'Add'}
          </EditorButton>
        </Flex>
      </Flex>
    </Box>
  );
}

function EditorRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex align="center" gap="3">
      <Text fontSize="11px" color="#7d8590" w="64px" flexShrink={0}>
        {label}
      </Text>
      <Box flex="1" minW="0">
        {children}
      </Box>
    </Flex>
  );
}

function EditorButton({
  children,
  onClick,
  primary,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Box
      as="button"
      onClick={() => {
        if (!disabled) onClick();
      }}
      px="3"
      h="24px"
      borderRadius="4px"
      fontSize="11px"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.4 : 1}
      bg={primary ? '#238636' : 'transparent'}
      border={primary ? 'none' : '1px solid #30363d'}
      color={primary ? '#ffffff' : '#c9d1d9'}
      _hover={disabled ? undefined : { bg: primary ? '#2ea043' : '#21262d' }}
    >
      {children}
    </Box>
  );
}
