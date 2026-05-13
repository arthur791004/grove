import { Box, Flex, HStack, Input, Text } from '@chakra-ui/react';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore, type Tab, type Group } from './store';
import { COLOR_HEX, COLOR_ORDER } from './colors';
import { useTabContext } from './useTabContext';
import { API_BASE } from './api';

interface ColorPopupCtx {
  openTabId: string | null;
  setOpenTabId: (id: string | null) => void;
}
const ColorPopupContext = createContext<ColorPopupCtx>({
  openTabId: null,
  setOpenTabId: () => {},
});

export function Sidebar() {
  const groups = useStore((s) => s.groups);
  const groupOrder = useStore((s) => s.groupOrder);
  const reorderGroups = useStore((s) => s.reorderGroups);
  const moveTab = useStore((s) => s.moveTab);
  const tabs = useStore((s) => s.tabs);
  const tabOrderByGroup = useStore((s) => s.tabOrderByGroup);
  const [colorPopupTabId, setColorPopupTabId] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  useEffect(() => {
    if (!colorPopupTabId) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('[data-color-popup-host]')) setColorPopupTabId(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [colorPopupTabId]);

  const orderedGroups = groupOrder
    .map((id) => groups.find((g) => g.id === id))
    .filter(Boolean) as Group[];

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function onDragStart(e: DragStartEvent) {
    setActiveDragId(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    if (activeId.startsWith('group:') && overId.startsWith('group:')) {
      const a = activeId.slice(6);
      const b = overId.slice(6);
      const oldIndex = groupOrder.indexOf(a);
      const newIndex = groupOrder.indexOf(b);
      if (oldIndex >= 0 && newIndex >= 0) reorderGroups(arrayMove(groupOrder, oldIndex, newIndex));
      return;
    }

    if (activeId.startsWith('tab:')) {
      const tabId = activeId.slice(4);
      if (overId.startsWith('tab:')) {
        const overTabId = overId.slice(4);
        const overTab = tabs.find((t) => t.id === overTabId);
        if (!overTab) return;
        const order = tabOrderByGroup[overTab.groupId] ?? [];
        const idx = order.indexOf(overTabId);
        moveTab(tabId, overTab.groupId, idx);
      } else if (overId.startsWith('group:')) {
        const gid = overId.slice(6);
        moveTab(tabId, gid, (tabOrderByGroup[gid] ?? []).length);
      }
    }
  }

  // When dragging a workspace, ignore tab cards as drop targets so the active
  // group doesn't "snap" into another group's tab list mid-drag. Tab drags
  // still resolve against both groups (for cross-group moves) and tab cards.
  const collisionDetection: CollisionDetection = (args) => {
    const activeId = String(args.active.id);
    if (activeId.startsWith('group:')) {
      const groupsOnly = args.droppableContainers.filter((c) =>
        String(c.id).startsWith('group:'),
      );
      return closestCenter({ ...args, droppableContainers: groupsOnly });
    }
    return closestCenter(args);
  };

  return (
    <ColorPopupContext.Provider value={{ openTabId: colorPopupTabId, setOpenTabId: setColorPopupTabId }}>
      <Box h="100%" display="flex" flexDirection="column" bg="#0d1117">
        <Box flex="1" overflowY="auto" px="2" pt="2" pb="2">
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setActiveDragId(null)}
          >
            <SortableContext
              items={orderedGroups.map((g) => `group:${g.id}`)}
              strategy={verticalListSortingStrategy}
            >
              {orderedGroups.map((g) => (
                <GroupSection key={g.id} group={g} />
              ))}
            </SortableContext>
            <DragOverlay dropAnimation={null}>
              {activeDragId && <DragPreview id={activeDragId} />}
            </DragOverlay>
          </DndContext>
        </Box>

      </Box>
    </ColorPopupContext.Provider>
  );
}

function SidebarIconButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        color: '#7d8590',
        cursor: 'pointer',
        padding: 0,
        margin: 0,
        height: '24px',
        width: '24px',
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );
}

function GroupSection({ group }: { group: Group }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isSorting } = useSortable({
    id: `group:${group.id}`,
  });
  const tabs = useStore((s) => s.tabs);
  const tabOrderByGroup = useStore((s) => s.tabOrderByGroup);
  const toggleGroup = useStore((s) => s.toggleGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const newTab = useStore((s) => s.newTab);
  const [editingCwd, setEditingCwd] = useState(false);
  const setGroupCwd = useStore((s) => s.setGroupCwd);
  const autoEditCwdGroupId = useStore((s) => s.autoEditCwdGroupId);
  const setAutoEditCwdGroupId = useStore((s) => s.setAutoEditCwdGroupId);
  const justDraggedRef = useRef(false);

  useEffect(() => {
    if (autoEditCwdGroupId === group.id) {
      pickFolder();
      setAutoEditCwdGroupId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditCwdGroupId, group.id]);

  async function pickFolder() {
    if (window.grove?.pickFolder) {
      const folder = await window.grove.pickFolder();
      if (folder) setGroupCwd(group.id, folder);
      return;
    }
    setEditingCwd(true);
  }
  const wasDragging = useRef(false);
  useEffect(() => {
    if (wasDragging.current && !isDragging) {
      justDraggedRef.current = true;
      const t = setTimeout(() => { justDraggedRef.current = false; }, 250);
      return () => clearTimeout(t);
    }
    wasDragging.current = isDragging;
  }, [isDragging]);

  const order = tabOrderByGroup[group.id] ?? [];
  const groupTabs = useMemo(
    () => order.map((id) => tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t),
    [order, tabs],
  );

  // Other items still shift to make space via `transform`. The dragged item
  // itself becomes invisible at source (DragOverlay renders the clean preview).
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  return (
    <Box
      ref={setNodeRef}
      style={style}
      mb="2"
      position="relative"
    >
      <Flex
        align="center"
        px="1.5"
        h="32px"
        gap="1.5"
        borderRadius="4px"
        cursor="pointer"
        position="relative"
        _hover={{ bg: '#161b22', '& .group-actions': { opacity: 1 } }}
        onClick={() => {
          if (editingCwd || justDraggedRef.current || isDragging || isSorting) return;
          toggleGroup(group.id);
        }}
        {...attributes}
        {...listeners}
      >
        <Box
          color="#7d8590"
          display="flex"
          alignItems="center"
          style={{
            transform: group.collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            transition: 'transform 180ms cubic-bezier(0.22, 0.61, 0.36, 1)',
          }}
        >
          <ChevronIcon />
        </Box>
        <Box
          color="#7d8590"
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="20px"
          h="20px"
          flexShrink={0}
          cursor="pointer"
          onClick={(e) => { e.stopPropagation(); pickFolder(); }}
          title="Change folder"
          _hover={{ color: '#c9d1d9' }}
        >
          <FolderIcon />
        </Box>
        <Box flex="1" minW="0">
          {editingCwd ? (
            <Input
              size="xs"
              defaultValue={group.cwd}
              autoFocus
              placeholder="~/path/to/folder"
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => { setGroupCwd(group.id, e.target.value || group.cwd); setEditingCwd(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { setGroupCwd(group.id, (e.target as HTMLInputElement).value || group.cwd); setEditingCwd(false); }
                if (e.key === 'Escape') setEditingCwd(false);
              }}
              color="#c9d1d9"
              bg="#0d1117"
              borderColor="#30363d"
              h="20px"
              fontSize="12px"
              fontFamily="var(--grove-mono)"
            />
          ) : (
            <Text
              fontSize="12px"
              color="#c9d1d9"
              fontWeight="500"
              truncate
              lineHeight="1.4"
              title={group.cwd}
            >
              {group.name}
            </Text>
          )}
        </Box>
        <HStack
          className="group-actions"
          gap="1"
          position="absolute"
          right="4px"
          top="50%"
          transform="translateY(-50%)"
          bg="#161b22"
          pl="6px"
          borderRadius="4px"
          opacity="0"
          transition="opacity 0.12s"
        >
        <button
          title="New tab in group"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); newTab(group.id); }}
          style={{
            background: 'transparent', border: 'none',
            color: '#7d8590', cursor: 'pointer',
            width: 20, height: 20,
            borderRadius: 4,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: 0,
          }}
        >
          <PlusIcon />
        </button>
        <button
          title="Delete group"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); removeGroup(group.id); }}
          style={{
            background: 'transparent', border: 'none',
            color: '#7d8590', cursor: 'pointer',
            width: 20, height: 20,
            borderRadius: 4,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: 0,
          }}
        >
          <CloseIcon />
        </button>
        </HStack>
      </Flex>

      {groupTabs.length > 0 && (
        <CollapsePanel open={!group.collapsed}>
          <SortableContext
            items={groupTabs.map((t) => `tab:${t.id}`)}
            strategy={verticalListSortingStrategy}
          >
            <Flex direction="column" gap="1" pt="1">
              {groupTabs.map((t) => (
                <TabCard key={t.id} tab={t} />
              ))}
            </Flex>
          </SortableContext>
        </CollapsePanel>
      )}
    </Box>
  );
}

function DragPreview({ id }: { id: string }) {
  const groups = useStore((s) => s.groups);
  const tabs = useStore((s) => s.tabs);
  if (id.startsWith('group:')) {
    const g = groups.find((gg) => gg.id === id.slice(6));
    if (!g) return null;
    return (
      <Flex
        align="center"
        px="1.5"
        h="32px"
        gap="1.5"
        borderRadius="4px"
        bg="#161b22"
        border="1px solid #30363d"
        boxShadow="0 8px 24px rgba(0,0,0,0.4)"
        opacity={0.9}
      >
        <Box w="10px" />
        <Box w="20px" h="20px" color="#7d8590" display="flex" alignItems="center" justifyContent="center">
          <FolderIcon />
        </Box>
        <Text fontSize="12px" color="#c9d1d9" fontWeight="500" lineHeight="1.4" truncate>
          {g.name}
        </Text>
      </Flex>
    );
  }
  if (id.startsWith('tab:')) {
    const t = tabs.find((tt) => tt.id === id.slice(4));
    if (!t) return null;
    const isDefault = t.color === 'default';
    return (
      <Flex
        align="center"
        gap="1.5"
        px="1.5"
        h="32px"
        borderRadius="6px"
        bg="#21262d"
        border="1px solid #30363d"
        boxShadow="0 8px 24px rgba(0,0,0,0.4)"
        opacity={0.9}
      >
        <Box w="10px" />
        <Box
          w="20px"
          h="20px"
          borderRadius="4px"
          bg={isDefault ? '#161b22' : COLOR_HEX[t.color] + '33'}
          border="1px solid"
          borderColor={isDefault ? '#21262d' : COLOR_HEX[t.color] + '66'}
          display="flex"
          alignItems="center"
          justifyContent="center"
          color={isDefault ? '#7d8590' : COLOR_HEX[t.color]}
        >
          <TerminalIcon />
        </Box>
        <Text fontSize="12px" color={isDefault ? '#f0f6fc' : COLOR_HEX[t.color]} truncate lineHeight="1.4">
          {t.title}
        </Text>
      </Flex>
    );
  }
  return null;
}

function CollapsePanel({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: open ? '1fr' : '0fr',
        transition: 'grid-template-rows 220ms cubic-bezier(0.22, 0.61, 0.36, 1)',
      }}
    >
      <div style={{ overflow: 'hidden', minHeight: 0 }}>{children}</div>
    </div>
  );
}

function TabCard({ tab }: { tab: Tab }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `tab:${tab.id}`,
  });
  const active = useStore((s) => s.activeTabId === tab.id);
  const setActive = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const renameTab = useStore((s) => s.renameTab);
  const setColor = useStore((s) => s.setTabColor);
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const runningCmd = useStore((s) => s.runningCmds[tab.id]);
  // Only poll context for tabs the user is looking at or has a command in.
  // Idle tabs keep their last cached ctx (branch/node/etc.) without spamming
  // /context every 1.5s × every-tab.
  const ctx = useTabContext(tab.id, 0, 1500, active || !!runningCmd);
  const group = useStore((s) => s.groups.find((g) => g.id === tab.groupId));
  const { openTabId, setOpenTabId } = useContext(ColorPopupContext);
  const showColors = openTabId === tab.id;
  const toggleColors = () => setOpenTabId(showColors ? null : tab.id);
  const ref = useRef<HTMLDivElement | null>(null);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  const branch = ctx?.branch ?? null;
  const isDefault = tab.color === 'default';
  const flexElRef = useRef<HTMLElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!showColors) { setMenuPos(null); return; }
    const el = flexElRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: Math.max(8, r.right - 220) });
  }, [showColors]);

  return (
    <>
    <Flex
      ref={(el) => { setNodeRef(el); ref.current = el; flexElRef.current = el; }}
      style={style}
      align="center"
      gap="1.5"
      px="1.5"
      h="32px"
      borderRadius="6px"
      bg={active ? '#21262d' : 'transparent'}
      _hover={{ bg: active ? '#21262d' : '#161b22' }}
      cursor="pointer"
      onClick={() => setActive(tab.id)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setOpenTabId(tab.id); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      position="relative"
      {...attributes}
      {...listeners}
    >
      <Box w="10px" h="20px" flexShrink={0} />
      <Box
        as={runningCmd ? 'button' : 'div'}
        w="20px"
        h="20px"
        borderRadius="4px"
        bg={isDefault ? '#161b22' : COLOR_HEX[tab.color] + '33'}
        border="1px solid"
        borderColor={isDefault ? '#21262d' : COLOR_HEX[tab.color] + '66'}
        display="flex"
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
        color={isDefault ? '#7d8590' : COLOR_HEX[tab.color]}
        cursor={runningCmd ? 'pointer' : 'default'}
        title={runningCmd ? `Stop "${runningCmd}" (send ⌃C)` : undefined}
        onPointerDown={runningCmd ? (e: React.PointerEvent) => e.stopPropagation() : undefined}
        onMouseDown={runningCmd ? (e: React.MouseEvent) => e.stopPropagation() : undefined}
        onClick={runningCmd ? (e: React.MouseEvent) => {
          e.stopPropagation();
          fetch(`${API_BASE}/session/${tab.id}/input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: '\x03' }),
          }).catch(() => {});
        } : undefined}
        _hover={runningCmd ? { color: '#f85149' } : undefined}
      >
        {runningCmd ? <StopIcon /> : <TerminalIcon />}
      </Box>

      <Box flex="1" minW="0">
        {editing ? (
          <Input
            size="xs"
            defaultValue={tab.title}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { renameTab(tab.id, e.target.value || tab.title); setEditing(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { renameTab(tab.id, (e.target as HTMLInputElement).value || tab.title); setEditing(false); }
              if (e.key === 'Escape') setEditing(false);
            }}
            color="#c9d1d9"
            bg="#0d1117"
            borderColor="#30363d"
          />
        ) : runningCmd ? (
          <Text
            fontSize="12px"
            color="#7d8590"
            fontFamily="var(--grove-mono)"
            truncate
            lineHeight="1.4"
            title={runningCmd}
          >
            {runningCmd}
          </Text>
        ) : (
          <Text
            fontSize="12px"
            color={isDefault ? (active ? '#f0f6fc' : '#c9d1d9') : COLOR_HEX[tab.color]}
            fontWeight={active ? '500' : '400'}
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
            truncate
            lineHeight="1.4"
          >
            {tab.title}
          </Text>
        )}
      </Box>
      {branch && !hovered && !showColors && !runningCmd && (
        <Box
          flexShrink={0}
          px="1.5"
          py="0.5"
          maxW="80px"
          bg="#161b22"
          border="1px solid #21262d"
          borderRadius="4px"
          color="#7ee787"
          fontSize="10px"
          fontFamily="var(--grove-mono)"
          lineHeight="1"
          display="inline-flex"
          alignItems="center"
          gap="1"
          minW="0"
          overflow="hidden"
          title={branch}
        >
          <Box flexShrink={0} display="inline-flex" alignItems="center">
            <BranchIcon />
          </Box>
          <Box truncate minW="0">{branch}</Box>
        </Box>
      )}

      {(hovered || showColors) && (
        <HStack
          gap="1"
          position="absolute"
          right="4px"
          top="50%"
          transform="translateY(-50%)"
          bg={active ? '#21262d' : '#161b22'}
          pl="6px"
          borderRadius="4px"
        >
          <button
            data-color-popup-host
            title="More"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); toggleColors(); }}
            style={{
              background: 'transparent', border: 'none',
              color: '#7d8590', cursor: 'pointer',
              width: 20, height: 20,
              borderRadius: 4,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: 0,
            }}
          >
            <KebabIcon />
          </button>
          <button
            title="Close"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
            style={{
              background: 'transparent', border: 'none',
              color: '#7d8590', cursor: 'pointer',
              width: 20, height: 20,
              borderRadius: 4,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: 0,
            }}
          >
            <CloseIcon />
          </button>
        </HStack>
      )}

    </Flex>
    {showColors && menuPos && createPortal(
      <Box
        data-color-popup-host
        position="fixed"
        top={`${menuPos.top}px`}
        left={`${menuPos.left}px`}
        bg="#161b22"
        border="1px solid #30363d"
        borderRadius="6px"
        py="1"
        zIndex={1000}
        minW="220px"
        boxShadow="0 10px 30px rgba(0,0,0,0.5)"
        onClick={(e) => e.stopPropagation()}
      >
        <TabMenuItem onClick={() => { navigator.clipboard.writeText(ctx?.shortCwd || group?.cwd || ''); setOpenTabId(null); }}>
          Copy working directory
        </TabMenuItem>
        <TabMenuItem onClick={() => { navigator.clipboard.writeText(tab.title); setOpenTabId(null); }}>
          Copy name
        </TabMenuItem>
        {branch && (
          <TabMenuItem onClick={() => { navigator.clipboard.writeText(branch); setOpenTabId(null); }}>
            Copy branch
          </TabMenuItem>
        )}
        <Box borderTop="1px solid #30363d" my="1" />
        <TabMenuItem onClick={() => { closeTab(tab.id); setOpenTabId(null); }} danger>
          Close
        </TabMenuItem>
        <Box borderTop="1px solid #30363d" my="1" />
        <Flex gap="1" px="2" py="1" justify="space-between">
          {COLOR_ORDER.map((c) => (
            <button
              key={c}
              title={c}
              onClick={(e) => { e.stopPropagation(); setColor(tab.id, c); setOpenTabId(null); }}
              style={{
                width: 16, height: 16, borderRadius: 8, background: COLOR_HEX[c],
                border: tab.color === c ? '2px solid #c9d1d9' : '1px solid #30363d',
                cursor: 'pointer',
              }}
            />
          ))}
        </Flex>
      </Box>,
      document.body,
    )}
    </>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2.5 3.5L5 6L7.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function KebabIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <circle cx="5" cy="1.5" r="1" />
      <circle cx="5" cy="5" r="1" />
      <circle cx="5" cy="8.5" r="1" />
    </svg>
  );
}

function TabMenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <Box
      px="3"
      py="1.5"
      cursor="pointer"
      onClick={onClick}
      _hover={{ bg: danger ? '#f8514922' : '#1f6feb' }}
    >
      <Text fontSize="12px" color={danger ? '#f85149' : '#f0f6fc'}>{children}</Text>
    </Box>
  );
}

function BranchIcon() {
  return (
    <svg width="8" height="10" viewBox="0 0 10 12" fill="none">
      <circle cx="2" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <circle cx="2" cy="9.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <circle cx="8" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <path d="M2 3.7v4.6M2 6c0-1.7 1.4-3.5 6-3.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 4a1 1 0 0 1 1-1h4l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11.5a1 1 0 0 1-1-1V4z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 4.5L6 7.5L3 10.5M7 11.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="grove-sq-icon" width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <rect x="1" y="1" width="3.5" height="3.5" rx="0.5" />
      <rect x="5.5" y="1" width="3.5" height="3.5" rx="0.5" />
      <rect x="5.5" y="5.5" width="3.5" height="3.5" rx="0.5" />
      <rect x="1" y="5.5" width="3.5" height="3.5" rx="0.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function NewGroupIcon() {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" fill="none">
      <path d="M1 2.5a1 1 0 0 1 1-1h3.5l1.5 1.5h5a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M7 5.5v3M5.5 7h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
