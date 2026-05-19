import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, HStack, Input, Portal, Text } from '@chakra-ui/react';
import { TerminalSquare } from 'lucide-react';
import { useStore, type AgentState, type Group, type Tab } from './store';
import { COLOR_HEX } from './colors';
import { shortPath } from './paths';
import { API_BASE } from './api';

interface AgentRow {
  tab: Tab;
  state: AgentState;
  reply: string | null;
  group: Group | undefined;
}

export function AgentsFooter() {
  const tabs = useStore((s) => s.tabs);
  const groups = useStore((s) => s.groups);
  const agentStates = useStore((s) => s.agentStates);
  const agentReplies = useStore((s) => s.agentReplies);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  const rows = useMemo<AgentRow[]>(() => {
    const tabIdx = new Map(tabs.map((t) => [t.id, t]));
    const groupIdx = new Map(groups.map((g) => [g.id, g]));
    return Object.entries(agentStates).flatMap(([id, state]) => {
      const tab = tabIdx.get(id);
      if (!tab) return [];
      return [{ tab, state, reply: agentReplies[id] ?? null, group: groupIdx.get(tab.groupId) }];
    });
  }, [tabs, groups, agentStates, agentReplies]);

  const counts = useMemo(() => {
    let working = 0;
    let blocked = 0;
    for (const r of rows) {
      if (r.state === 'working') working++;
      else blocked++;
    }
    return { working, blocked };
  }, [rows]);

  useEffect(() => {
    if (rows.length === 0 && open) setOpen(false);
  }, [rows.length, open]);

  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
    const onDocPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (rows.length === 0) return null;

  const summaryColor = counts.blocked > 0 ? COLOR_HEX.red : COLOR_HEX.yellow;

  return (
    <>
      <Box borderTop="1px solid #21262d" px="2" py="1.5" flexShrink={0}>
        <button
          ref={triggerRef}
          onClick={() => setOpen((v) => !v)}
          style={{
            width: '100%',
            background: open ? '#1c2128' : 'transparent',
            border: 'none',
            borderRadius: 4,
            padding: '4px 8px',
            color: '#c9d1d9',
            fontSize: 11,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Box
            w="6px"
            h="6px"
            borderRadius="full"
            bg={summaryColor}
            animation={counts.blocked === 0 ? 'grove-pulse 1.4s ease-in-out infinite' : undefined}
            flexShrink={0}
          />
          <Text fontSize="11px" color="#c9d1d9">
            {counts.working > 0 && `${counts.working} working`}
            {counts.working > 0 && counts.blocked > 0 && ' · '}
            {counts.blocked > 0 && `${counts.blocked} blocked`}
          </Text>
        </button>
      </Box>
      {open && pos && (
        <Portal>
          <Box
            ref={popoverRef}
            position="fixed"
            left={`${pos.left}px`}
            bottom={`${pos.bottom}px`}
            w="340px"
            maxH="60vh"
            overflowY="auto"
            bg="#161b22"
            border="1px solid #30363d"
            borderRadius="6px"
            boxShadow="0 8px 24px rgba(0,0,0,0.5)"
            zIndex={1000}
            p="1"
          >
            {rows.map(({ tab, state, reply, group }) => (
              <AgentsFooterRow
                key={tab.id}
                tab={tab}
                state={state}
                reply={reply}
                group={group}
                onActivate={() => {
                  setActiveTab(tab.id);
                  setOpen(false);
                }}
              />
            ))}
          </Box>
        </Portal>
      )}
    </>
  );
}

function AgentsFooterRow({
  tab,
  state,
  reply,
  group,
  onActivate,
}: {
  tab: Tab;
  state: AgentState;
  reply: string | null;
  group: Group | undefined;
  onActivate: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const tabColor = COLOR_HEX[tab.color];
  const stateColor = state === 'blocked' ? COLOR_HEX.red : COLOR_HEX.yellow;
  const workspace = group?.name || (group?.cwd ? shortPath(group.cwd) : null);

  async function send() {
    const text = draft;
    if (!text || sending) return;
    setSending(true);
    try {
      await fetch(`${API_BASE}/session/${tab.id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: text + '\r' }),
      });
      setDraft('');
    } catch {
    } finally {
      setSending(false);
    }
  }

  return (
    <Box px="2" py="2" borderRadius="4px" _hover={{ bg: '#1c2128' }}>
      <HStack gap="2" mb="1" align="start">
        <Box mt="2px" color={tabColor} flexShrink={0} display="flex">
          <TerminalSquare size={14} />
        </Box>
        <Box flex="1" minW={0} cursor="pointer" onClick={onActivate}>
          <HStack gap="2" align="baseline">
            <Text fontSize="12px" color="#c9d1d9" truncate>
              {tab.title}
            </Text>
            {workspace && (
              <Text fontSize="10px" color="#7d8590" truncate>
                {workspace}
              </Text>
            )}
          </HStack>
          {reply && (
            <Text
              fontSize="10px"
              color="#8b949e"
              truncate
              mt="2px"
              fontFamily="var(--grove-mono)"
            >
              {reply}
            </Text>
          )}
        </Box>
        <HStack gap="1" flexShrink={0}>
          <Box
            w="6px"
            h="6px"
            borderRadius="full"
            bg={stateColor}
            animation={state === 'working' ? 'grove-pulse 1.4s ease-in-out infinite' : undefined}
          />
          <Text fontSize="10px" color={stateColor}>
            {state}
          </Text>
        </HStack>
      </HStack>
      <Input
        size="xs"
        placeholder={state === 'blocked' ? 'Reply to unblock…' : 'Send to Claude…'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            send();
          }
        }}
        bg="#0d1117"
        border="1px solid #21262d"
        color="#c9d1d9"
        fontSize="11px"
        fontFamily="var(--grove-mono)"
        _focus={{ borderColor: '#388bfd', outline: 'none' }}
      />
    </Box>
  );
}
