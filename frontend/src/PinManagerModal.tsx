import { memo, useMemo, useState } from 'react';
import { Box, CloseButton, Dialog, Flex, Input, Portal, SegmentGroup, Text } from '@chakra-ui/react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronLeft, Eye, EyeOff, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useStore, type Pin, type PinScope, type PinType } from './store';
import { Tooltip } from './Tooltip';
import { ClaudeIcon, TerminalIcon } from './icons';

// Open-state for the pin manager modal. `add` carries an optional pre-filled
// draft ("Pin this command" from a terminal block); `edit` carries the pin.
export type ManagerState =
  | { mode: 'closed' }
  | { mode: 'list' }
  | { mode: 'add'; draft?: Omit<Pin, 'id'> }
  | { mode: 'edit'; pin: Pin };

type EditorMode = Extract<ManagerState, { mode: 'add' | 'edit' }>;

// Drop-target id for a section, kept distinct from pin ids so the drag
// handlers can tell "dropped on the section" from "dropped on a row".
const scopeDropId = (scope: PinScope) => `scope:${scope}`;
const scopeFromDropId = (id: string): PinScope | null =>
  id === scopeDropId('global') ? 'global' : id === scopeDropId('workspace') ? 'workspace' : null;

// The pin manager — one modal for everything pin-related: reorder, toggle
// visibility, add, edit, remove. Opened from the strip's `[+]` button (and
// from "Pin this command", which lands straight in the add form).
//
// Memoized: PinBar re-renders on its own store subscriptions (pins, drafts);
// without memo each of those would reconcile the open modal and its dnd-kit
// machinery for no reason.
export const PinManagerModal = memo(function PinManagerModal({
  state,
  setState,
  activeGroupId,
}: {
  state: ManagerState;
  setState: (s: ManagerState) => void;
  activeGroupId: string | null;
}) {
  const editing = state.mode === 'add' || state.mode === 'edit';
  const title = state.mode === 'add' ? 'New pin' : state.mode === 'edit' ? 'Edit pin' : 'Pins';

  return (
    <Dialog.Root
      open={state.mode !== 'closed'}
      onOpenChange={(e) => {
        if (!e.open) setState({ mode: 'closed' });
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop bg="rgba(0,0,0,0.5)" />
        <Dialog.Positioner>
          <Dialog.Content
            bg="#161b22"
            border="1px solid #30363d"
            borderRadius="8px"
            boxShadow="0 20px 60px rgba(0,0,0,0.6)"
            w="440px"
            maxW="440px"
            // Fixed height so the modal doesn't jump when switching between
            // the list and the add/edit form.
            h="440px"
            maxH="80vh"
            display="flex"
            flexDirection="column"
          >
            <Dialog.Header
              px="4"
              py="3"
              borderBottom="1px solid #30363d"
              display="flex"
              alignItems="center"
              justifyContent="space-between"
            >
              <Flex align="center" gap="1.5">
                {editing && (
                  <Box
                    as="button"
                    onClick={() => setState({ mode: 'list' })}
                    display="inline-flex"
                    color="#7d8590"
                    cursor="pointer"
                    _hover={{ color: '#c9d1d9' }}
                    aria-label="Back to pin list"
                  >
                    <ChevronLeft size={18} />
                  </Box>
                )}
                <Dialog.Title fontSize="14px" color="#f0f6fc" fontWeight="600">
                  {title}
                </Dialog.Title>
              </Flex>
              <Flex align="center" gap="1">
                {state.mode === 'list' && (
                  <Tooltip label="Add pin">
                    <Box
                      as="button"
                      onClick={() => setState({ mode: 'add' })}
                      display="inline-flex"
                      alignItems="center"
                      justifyContent="center"
                      w="28px"
                      h="28px"
                      borderRadius="6px"
                      color="#7d8590"
                      cursor="pointer"
                      _hover={{ bg: '#21262d', color: '#c9d1d9' }}
                      aria-label="Add pin"
                    >
                      <Plus size={16} />
                    </Box>
                  </Tooltip>
                )}
                {/* Chakra anchors the close trigger absolutely to the
                    corner — pull it back into flow so it sits beside the
                    add button instead of overlapping it. */}
                <Dialog.CloseTrigger asChild>
                  <CloseButton size="sm" color="#7d8590" position="static" />
                </Dialog.CloseTrigger>
              </Flex>
            </Dialog.Header>
            <Dialog.Body flex="1" overflowY="auto" p="0">
              {state.mode === 'list' && (
                <PinList
                  activeGroupId={activeGroupId}
                  onEdit={(pin) => setState({ mode: 'edit', pin })}
                />
              )}
              {editing && (
                <PinEditor
                  state={state as EditorMode}
                  activeGroupId={activeGroupId}
                  onClose={() => setState({ mode: 'list' })}
                />
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
});

type DragLists = { global: string[]; workspace: string[] };

function sameOrder(a: string[], b: string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function PinList({
  activeGroupId,
  onEdit,
}: {
  activeGroupId: string | null;
  onEdit: (pin: Pin) => void;
}) {
  const pins = useStore((s) => s.pins);
  const updatePin = useStore((s) => s.updatePin);
  const reorderPins = useStore((s) => s.reorderPins);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Derived from the store only — `PinList` also re-renders on every drag
  // frame, so keep these off that hot path.
  const byId = useMemo(() => new Map(pins.map((p) => [p.id, p])), [pins]);
  const storeGlobal = useMemo(
    () => pins.filter((p) => p.scope === 'global').map((p) => p.id),
    [pins],
  );
  const storeWs = useMemo(
    () =>
      activeGroupId
        ? pins.filter((p) => p.scope === 'workspace' && p.groupId === activeGroupId).map((p) => p.id)
        : [],
    [pins, activeGroupId],
  );

  // While a drag is in flight, `dragLists` mirrors the two columns so
  // onDragOver can re-home a row across the boundary for live "make room"
  // feedback; null when idle (render straight from the store).
  const [dragLists, setDragLists] = useState<DragLists | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const globalIds = dragLists ? dragLists.global : storeGlobal;
  const wsIds = dragLists ? dragLists.workspace : storeWs;
  const globalPins = globalIds.map((id) => byId.get(id)).filter(Boolean) as Pin[];
  const wsPins = wsIds.map((id) => byId.get(id)).filter(Boolean) as Pin[];

  const containerOf = (lists: DragLists, id: string): keyof DragLists | null => {
    const section = scopeFromDropId(id);
    if (section) return section;
    if (lists.global.includes(id)) return 'global';
    if (lists.workspace.includes(id)) return 'workspace';
    return null;
  };

  function onDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as string);
    setDragLists({ global: storeGlobal, workspace: storeWs });
  }

  // Cross-column only: re-home the dragged id so it renders (and reflows) in
  // the target column. Within-column movement is handled visually by
  // SortableContext and finalised in onDragEnd.
  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    setDragLists((prev) => {
      if (!prev) return prev;
      const id = active.id as string;
      const from = containerOf(prev, id);
      const to = containerOf(prev, over.id as string);
      if (!from || !to || from === to) return prev;
      if (to === 'workspace' && !activeGroupId) return prev;
      const overId = over.id as string;
      const toList = prev[to];
      let at = toList.indexOf(overId);
      if (at < 0) at = toList.length;
      return {
        ...prev,
        [from]: prev[from].filter((x) => x !== id),
        [to]: [...toList.slice(0, at), id, ...toList.slice(at)],
      };
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    const lists = dragLists;
    setDragLists(null);
    setActiveId(null);
    if (!over || !lists) return;
    const id = active.id as string;
    const overId = over.id as string;
    const container = containerOf(lists, overId);
    if (!container) return;

    // Final within-column reorder onto the hovered sibling (skipped when the
    // drop landed on the section itself rather than a row).
    let next = lists;
    if (scopeFromDropId(overId) === null) {
      const arr = lists[container];
      const from = arr.indexOf(id);
      const to = arr.indexOf(overId);
      if (from >= 0 && to >= 0 && from !== to) {
        next = { ...lists, [container]: arrayMove(arr, from, to) };
      }
    }

    const globalChanged = !sameOrder(next.global, storeGlobal);
    const wsChanged = !sameOrder(next.workspace, storeWs);
    if (!globalChanged && !wsChanged) return;

    const pin = byId.get(id);
    const finalScope = containerOf(next, id);
    if (pin && finalScope && pin.scope !== finalScope) {
      updatePin(id, {
        scope: finalScope,
        groupId: finalScope === 'workspace' ? (activeGroupId ?? undefined) : undefined,
      });
    }
    if (globalChanged) reorderPins(next.global);
    if (wsChanged) reorderPins(next.workspace);
  }

  return (
    <Box pb="2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setDragLists(null);
          setActiveId(null);
        }}
      >
        <PinSection scope="global" title="Global" pins={globalPins} onEdit={onEdit} />
        {activeGroupId && (
          <PinSection scope="workspace" title="This workspace" pins={wsPins} onEdit={onEdit} />
        )}
        <DragOverlay>
          {activeId && byId.get(activeId) ? (
            <PinRowView pin={byId.get(activeId)!} onEdit={onEdit} overlay />
          ) : null}
        </DragOverlay>
      </DndContext>
    </Box>
  );
}

function PinSection({
  scope,
  title,
  pins,
  onEdit,
}: {
  scope: PinScope;
  title: string;
  pins: Pin[];
  onEdit: (pin: Pin) => void;
}) {
  // The whole section is a drop target so a row can be dropped onto it even
  // when it's empty (`scope:*` id) — that's how the first workspace pin gets in.
  const { setNodeRef, isOver } = useDroppable({ id: scopeDropId(scope) });
  const ids = pins.map((p) => p.id);

  return (
    <Box>
      <Text
        px="4"
        pt="3"
        pb="1"
        fontSize="10px"
        fontWeight="700"
        letterSpacing="0.06em"
        textTransform="uppercase"
        color="#7d8590"
      >
        {title}
      </Text>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <Box ref={setNodeRef} minH="30px" bg={isOver ? '#1c2128' : undefined}>
          {pins.length === 0 ? (
            <Text px="4" pb="1.5" fontSize="12px" color="#484f58">
              None yet
            </Text>
          ) : (
            pins.map((pin) => <PinRow key={pin.id} pin={pin} onEdit={onEdit} />)
          )}
        </Box>
      </SortableContext>
    </Box>
  );
}

function PinRow({ pin, onEdit }: { pin: Pin; onEdit: (pin: Pin) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: pin.id,
  });
  return (
    <PinRowView
      pin={pin}
      onEdit={onEdit}
      innerRef={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // The original goes invisible while dragging — the DragOverlay shows
        // the floating copy; the empty slot reflows to make room.
        opacity: isDragging ? 0 : 1,
      }}
      handleProps={{ ...attributes, ...listeners }}
    />
  );
}

function PinRowView({
  pin,
  onEdit,
  innerRef,
  style,
  handleProps,
  overlay,
}: {
  pin: Pin;
  onEdit: (pin: Pin) => void;
  innerRef?: (el: HTMLElement | null) => void;
  style?: React.CSSProperties;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleProps?: any;
  overlay?: boolean;
}) {
  const updatePin = useStore((s) => s.updatePin);
  const removePin = useStore((s) => s.removePin);
  const Icon = pin.type === 'claude' ? ClaudeIcon : TerminalIcon;
  const hidden = !!pin.hidden;

  return (
    <Flex
      ref={innerRef}
      style={style}
      align="center"
      gap="2"
      px="4"
      py="1.5"
      borderRadius={overlay ? '6px' : undefined}
      bg={overlay ? '#1c2128' : undefined}
      boxShadow={overlay ? '0 8px 22px rgba(0,0,0,0.5)' : undefined}
      _hover={overlay ? undefined : { bg: '#1c2128' }}
    >
      <Box
        as="button"
        {...(handleProps ?? {})}
        flexShrink={0}
        display="inline-flex"
        color="#484f58"
        cursor="grab"
        _hover={{ color: '#7d8590' }}
        aria-label="Drag to reorder"
      >
        <GripVertical size={14} />
      </Box>
      <Box
        flexShrink={0}
        display="inline-flex"
        color={pin.type === 'claude' ? '#a371f7' : '#7d8590'}
        opacity={hidden ? 0.4 : 1}
      >
        <Icon size={13} />
      </Box>
      <Box flex="1" minW="0" opacity={hidden ? 0.4 : 1}>
        <Text
          fontSize="12px"
          color="#c9d1d9"
          lineHeight="1.35"
          overflow="hidden"
          whiteSpace="nowrap"
          textOverflow="ellipsis"
        >
          {pin.label}
        </Text>
        <Text
          fontSize="11px"
          color="#7d8590"
          fontFamily="var(--grove-mono)"
          lineHeight="1.35"
          overflow="hidden"
          whiteSpace="nowrap"
          textOverflow="ellipsis"
        >
          {pin.command}
        </Text>
      </Box>
      <RowAction
        label={hidden ? 'Show in strip' : 'Hide from strip'}
        onClick={() => updatePin(pin.id, { hidden: !hidden })}
      >
        {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
      </RowAction>
      <RowAction label="Edit" onClick={() => onEdit(pin)}>
        <Pencil size={13} />
      </RowAction>
      <RowAction label="Remove" danger onClick={() => removePin(pin.id)}>
        <Trash2 size={13} />
      </RowAction>
    </Flex>
  );
}

function RowAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <Box
        as="button"
        onClick={onClick}
        flexShrink={0}
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
        w="26px"
        h="26px"
        borderRadius="5px"
        color="#7d8590"
        bg="transparent"
        cursor="pointer"
        _hover={{ bg: '#21262d', color: danger ? '#f85149' : '#c9d1d9' }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

function PinEditor({
  state,
  activeGroupId,
  onClose,
}: {
  state: EditorMode;
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
    <Box px="4" py="3">
      <Flex direction="column" gap="2.5">
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
            }}
          />
        </EditorRow>
        <EditorRow label="Type">
          <SegmentGroup.Root
            size="xs"
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
            }}
          />
        </EditorRow>
        <EditorRow label="Scope">
          <SegmentGroup.Root
            size="xs"
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
        <Flex justify="flex-end" gap="2" mt="1">
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
