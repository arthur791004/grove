import { Box, Flex, HStack, Input, Text } from '@chakra-ui/react';
import { useMemo, useState, useRef, useEffect } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
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

export function Sidebar() {
  const groups = useStore((s) => s.groups);
  const groupOrder = useStore((s) => s.groupOrder);
  const reorderGroups = useStore((s) => s.reorderGroups);
  const moveTab = useStore((s) => s.moveTab);
  const tabs = useStore((s) => s.tabs);
  const tabOrderByGroup = useStore((s) => s.tabOrderByGroup);
  const newGroup = useStore((s) => s.newGroup);
  const newTab = useStore((s) => s.newTab);
  const [query, setQuery] = useState('');

  const orderedGroups = groupOrder
    .map((id) => groups.find((g) => g.id === id))
    .filter(Boolean) as Group[];

  const queryLower = query.trim().toLowerCase();
  const matchTab = (t: Tab) => {
    if (!queryLower) return true;
    return t.title.toLowerCase().includes(queryLower);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function onDragEnd(e: DragEndEvent) {
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

  const showGroupHeaders = orderedGroups.length > 1 || orderedGroups[0]?.name !== 'default';

  return (
    <Box h="100%" display="flex" flexDirection="column" bg="#0d1117">
      <HStack px="2" py="2" gap="1">
        <Box position="relative" flex="1">
          <Box position="absolute" left="8px" top="50%" transform="translateY(-50%)" color="#7d8590" fontSize="12px" pointerEvents="none">
            ⌕
          </Box>
          <Input
            size="sm"
            placeholder="Search tabs..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            color="#c9d1d9"
            bg="#161b22"
            border="1px solid #21262d"
            _hover={{ borderColor: '#30363d' }}
            _focus={{ borderColor: '#388bfd', outline: 'none' }}
            pl="26px"
            fontSize="12px"
            h="28px"
          />
        </Box>
        <IconButton title="New group" onClick={() => newGroup('group')}>⊟</IconButton>
        <IconButton title="New tab (⌘T)" onClick={() => newTab()}>＋</IconButton>
      </HStack>

      <Box flex="1" overflowY="auto" px="2" pb="2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={orderedGroups.map((g) => `group:${g.id}`)}
            strategy={verticalListSortingStrategy}
          >
            {orderedGroups.map((g) => (
              <GroupSection
                key={g.id}
                group={g}
                showHeader={showGroupHeaders}
                matchTab={matchTab}
              />
            ))}
          </SortableContext>
        </DndContext>
      </Box>
    </Box>
  );
}

function IconButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: 'transparent',
        border: '1px solid #21262d',
        borderRadius: 6,
        color: '#c9d1d9',
        cursor: 'pointer',
        fontSize: 13,
        width: 28,
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );
}

function GroupSection({
  group, showHeader, matchTab,
}: { group: Group; showHeader: boolean; matchTab: (t: Tab) => boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `group:${group.id}`,
  });
  const tabs = useStore((s) => s.tabs);
  const tabOrderByGroup = useStore((s) => s.tabOrderByGroup);
  const renameGroup = useStore((s) => s.renameGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const newTab = useStore((s) => s.newTab);
  const [editing, setEditing] = useState(false);

  const order = tabOrderByGroup[group.id] ?? [];
  const groupTabs = useMemo(() => order
    .map((id) => tabs.find((t) => t.id === id))
    .filter((t): t is Tab => !!t && matchTab(t)),
    [order, tabs, matchTab],
  );

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <Box ref={setNodeRef} style={style} mb={showHeader ? '2' : '1'}>
      {showHeader && (
        <Flex
          align="center"
          px="3"
          pt="3"
          pb="1"
          gap="1"
          {...attributes}
          {...listeners}
          _hover={{ '& .group-actions': { opacity: 1 } }}
        >
          {editing ? (
            <Input
              size="xs"
              defaultValue={group.name}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => { renameGroup(group.id, e.target.value || group.name); setEditing(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { renameGroup(group.id, (e.target as HTMLInputElement).value || group.name); setEditing(false); }
                if (e.key === 'Escape') setEditing(false);
              }}
              color="#c9d1d9"
              bg="#0d1117"
              borderColor="#30363d"
              h="20px"
              fontSize="11px"
            />
          ) : (
            <Text
              flex="1"
              fontSize="11px"
              fontWeight="600"
              color="#7d8590"
              textTransform="uppercase"
              letterSpacing="0.04em"
              onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
              cursor="pointer"
            >
              {group.name}
            </Text>
          )}
          <HStack className="group-actions" gap="0" opacity="0" transition="opacity 0.15s" onClick={(e) => e.stopPropagation()}>
            <button
              title="New tab in group"
              onClick={() => newTab(group.id)}
              style={{ background: 'transparent', border: 'none', color: '#7d8590', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
            >＋</button>
            <button
              title="Delete group"
              onClick={() => removeGroup(group.id)}
              style={{ background: 'transparent', border: 'none', color: '#7d8590', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
            >×</button>
          </HStack>
        </Flex>
      )}

      <SortableContext
        items={groupTabs.map((t) => `tab:${t.id}`)}
        strategy={verticalListSortingStrategy}
      >
        <Flex direction="column" gap="1">
          {groupTabs.map((t) => (
            <TabCard key={t.id} tab={t} />
          ))}
        </Flex>
      </SortableContext>
    </Box>
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
  const [showColors, setShowColors] = useState(false);
  const [hovered, setHovered] = useState(false);
  const ctx = useTabContext(tab.id);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showColors) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowColors(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showColors]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const subtitle = ctx?.branch ?? ctx?.shortCwd ?? '';

  return (
    <Flex
      ref={(el) => { setNodeRef(el); ref.current = el; }}
      style={style}
      align="center"
      gap="2"
      p="2"
      borderRadius="6px"
      bg={active ? '#21262d' : 'transparent'}
      _hover={{ bg: active ? '#21262d' : '#161b22' }}
      cursor="pointer"
      onClick={() => setActive(tab.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      position="relative"
      {...attributes}
      {...listeners}
    >
      <Box
        w="28px"
        h="28px"
        borderRadius="6px"
        bg={tab.color === 'default' ? '#161b22' : COLOR_HEX[tab.color] + '33'}
        border="1px solid"
        borderColor={tab.color === 'default' ? '#21262d' : COLOR_HEX[tab.color] + '66'}
        display="flex"
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
        color={tab.color === 'default' ? '#7d8590' : COLOR_HEX[tab.color]}
        fontFamily="Menlo, monospace"
        fontSize="12px"
        fontWeight="bold"
      >
        &gt;_
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
        ) : (
          <Text
            fontSize="13px"
            color={active ? '#f0f6fc' : '#c9d1d9'}
            fontWeight={active ? '500' : '400'}
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
            truncate
            lineHeight="1.2"
          >
            {tab.title}
          </Text>
        )}
        {subtitle && (
          <Text
            fontSize="11px"
            color="#7d8590"
            truncate
            lineHeight="1.3"
            mt="1px"
          >
            {ctx?.branch ? '⎇ ' : ''}{subtitle}
          </Text>
        )}
      </Box>

      {(hovered || showColors) && (
        <HStack gap="1" onClick={(e) => e.stopPropagation()}>
          <button
            title="Color"
            onClick={(e) => { e.stopPropagation(); setShowColors((v) => !v); }}
            style={{
              width: 12, height: 12, borderRadius: 6, background: COLOR_HEX[tab.color],
              border: 'none', cursor: 'pointer', opacity: 0.8,
            }}
          />
          <button
            title="Close"
            onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
            style={{ background: 'transparent', border: 'none', color: '#7d8590', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
          >×</button>
        </HStack>
      )}

      {showColors && (
        <Box
          position="absolute"
          right="6px"
          top="100%"
          mt="4px"
          bg="#161b22"
          border="1px solid #30363d"
          borderRadius="6px"
          p="1"
          zIndex={10}
          display="flex"
          gap="1"
          onClick={(e) => e.stopPropagation()}
        >
          {COLOR_ORDER.map((c) => (
            <button
              key={c}
              onClick={(e) => { e.stopPropagation(); setColor(tab.id, c); setShowColors(false); }}
              style={{
                width: 14, height: 14, borderRadius: 7, background: COLOR_HEX[c],
                border: tab.color === c ? '2px solid #c9d1d9' : '1px solid #30363d',
                cursor: 'pointer',
              }}
            />
          ))}
        </Box>
      )}
    </Flex>
  );
}
