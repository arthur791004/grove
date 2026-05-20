import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Input, Portal, Text } from '@chakra-ui/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { useStore, type AgentPrompt, type AgentState, type Tab } from './store';
import { COLOR_HEX } from './colors';
import { sendSessionInput } from './api';
import { TabCard } from './Sidebar';

interface AgentRow {
  tab: Tab;
  state: AgentState;
  reply: string | null;
  prompt: AgentPrompt | null;
}

export function AgentsFooter() {
  const tabs = useStore((s) => s.tabs);
  const agentStates = useStore((s) => s.agentStates);
  const agentReplies = useStore((s) => s.agentReplies);
  const agentPrompts = useStore((s) => s.agentPrompts);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  const rows = useMemo<AgentRow[]>(() => {
    const tabIdx = new Map(tabs.map((t) => [t.id, t]));
    return Object.entries(agentStates).flatMap(([id, state]) => {
      const tab = tabIdx.get(id);
      if (!tab) return [];
      return [
        {
          tab,
          state,
          reply: agentReplies[id] ?? null,
          prompt: agentPrompts[id] ?? null,
        },
      ];
    });
  }, [tabs, agentStates, agentReplies, agentPrompts]);

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
            {/* Inert wrapper so TabCard's useSortable resolves; drag is a no-op here. */}
            <DndContext>
              <SortableContext items={rows.map((r) => `tab:${r.tab.id}`)}>
                {rows.map(({ tab, state, reply, prompt }) => (
                  <AgentsFooterRow
                    key={tab.id}
                    tab={tab}
                    state={state}
                    reply={reply}
                    prompt={prompt}
                  />
                ))}
              </SortableContext>
            </DndContext>
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
  prompt,
}: {
  tab: Tab;
  state: AgentState;
  reply: string | null;
  prompt: AgentPrompt | null;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const sendRaw = (data: string) => sendSessionInput(tab.id, data);

  async function send() {
    const text = draft;
    if (!text || sending) return;
    setSending(true);
    try {
      await sendRaw(text + '\r');
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  // For blocked rows with a parsed permission menu, show the question + the
  // numbered choices as buttons. Picking a choice sends `<n>\r` to Claude.
  // Otherwise fall back to the freeform input + last-reply snippet (Claude's
  // most recent assistant turn) so the user has context.
  const showPrompt = state === 'blocked' && prompt && prompt.choices.length > 0;
  const contextText = showPrompt ? prompt.question : reply;

  return (
    <Box pb="2">
      <TabCard tab={tab} workspaceBranch={null} compact />
      <Box px="2" pt="1">
        {contextText && (
          <Text
            fontSize="10px"
            color="#8b949e"
            mb="1.5"
            fontFamily="var(--grove-mono)"
            title={contextText}
            lineHeight="1.4"
            css={{
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {contextText}
          </Text>
        )}
        {showPrompt ? (
          <Box display="flex" flexDirection="column" gap="1">
            {prompt.choices.map((c, i) => {
              const digit = String(i + 1);
              return (
                <button
                  key={i}
                  onClick={() => sendRaw(digit + '\r')}
                  style={{
                    textAlign: 'left',
                    background: '#0d1117',
                    border: '1px solid #30363d',
                    borderRadius: 4,
                    color: '#c9d1d9',
                    fontFamily: 'var(--grove-mono)',
                    fontSize: 11,
                    lineHeight: '1.4',
                    padding: '4px 8px',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ color: '#7d8590', marginRight: 8 }}>{digit}.</span>
                  {c}
                </button>
              );
            })}
          </Box>
        ) : (
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
        )}
      </Box>
    </Box>
  );
}
