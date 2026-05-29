import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Flex, Text, Textarea } from '@chakra-ui/react';
import { ArrowRight, Bot, Plus, Sparkles, X } from 'lucide-react';
import { sendSessionInput } from './api';
import { useStore, type AgentState, type Tab } from './store';
import { useIsMobile } from './useViewport';

// The "send queued first-message once claude TUI is up" effect lives in
// App.tsx so it survives the user toggling this view off while claude is
// still booting. Don't reintroduce it here.

// Cross-workspace view of every Claude session. Replaces the main workspace
// content when `agentsViewOpen` is set. Reads entirely from existing store
// state — no separate IPC, no per-card data subscription — so updates from
// the backend's agent-state ticker flow in naturally via the existing zustand
// re-render path.

type DisplayStatus = 'working' | 'blocked' | 'done' | 'idle' | 'shell';

interface AgentRow {
  tab: Tab;
  label: string;
  status: DisplayStatus;
  state?: AgentState;
  reply?: string;
}

function statusOf(tab: Tab, state: AgentState | undefined): DisplayStatus {
  if (tab.kind !== 'claude') return 'shell';
  if (state === 'blocked') return 'blocked';
  if (state === 'working') return 'working';
  // No live agent state — distinguish "ran before" from "never started".
  if (tab.claudeSessionId) return 'done';
  return 'idle';
}

const STATUS_LABEL: Record<DisplayStatus, string> = {
  working: 'working',
  blocked: 'needs reply',
  done: 'done',
  idle: 'idle',
  shell: 'shell',
};

const STATUS_COLOR: Record<DisplayStatus, { dot: string; text: string; bg: string }> = {
  working: { dot: '#3fb950', text: '#7ee787', bg: '#0f2a17' },
  blocked: { dot: '#f85149', text: '#ffa198', bg: '#2d0e0e' },
  done: { dot: '#7d8590', text: '#c9d1d9', bg: '#21262d' },
  idle: { dot: '#484f58', text: '#7d8590', bg: '#161b22' },
  shell: { dot: '#58a6ff', text: '#79c0ff', bg: '#0c1f3a' },
};

export function AgentsView() {
  const groups = useStore((s) => s.groups);
  const groupOrder = useStore((s) => s.groupOrder);
  const tabs = useStore((s) => s.tabs);
  const tabOrderByGroup = useStore((s) => s.tabOrderByGroup);
  const agentStates = useStore((s) => s.agentStates);
  const agentReplies = useStore((s) => s.agentReplies);
  const isMobile = useIsMobile();

  // Build the workspace → agents map. Workspaces with zero Claude tabs are
  // hidden from the view; the empty state below replaces them with a single
  // big "no sessions" panel when every workspace is empty.
  const sections = useMemo(() => {
    const orderedGroups = groupOrder
      .map((id) => groups.find((g) => g.id === id))
      .filter((g): g is NonNullable<typeof g> => Boolean(g));
    return orderedGroups
      .map((g) => {
        const order = tabOrderByGroup[g.id] ?? [];
        const claudeTabs = order
          .map((id) => tabs.find((t) => t.id === id))
          .filter((t): t is Tab => !!t && t.kind === 'claude');
        const rows: AgentRow[] = claudeTabs.map((t) => ({
          tab: t,
          label: t.agentLabel || t.title || 'Claude session',
          state: agentStates[t.id],
          reply: agentReplies[t.id],
          status: statusOf(t, agentStates[t.id]),
        }));
        // Blocked first, then working, then done/idle/shell — matches the
        // user's attention order ("what's waiting on me?" before "what's
        // running?").
        rows.sort((a, b) => {
          const rank = { blocked: 0, working: 1, done: 2, shell: 3, idle: 4 } as const;
          return rank[a.status] - rank[b.status];
        });
        return { group: g, rows };
      })
      .filter((s) => s.rows.length > 0);
  }, [groupOrder, groups, tabOrderByGroup, tabs, agentStates, agentReplies]);

  const blockedCount = useMemo(
    () => Object.values(agentStates).filter((s) => s === 'blocked').length,
    [agentStates],
  );
  const totalCount = sections.reduce((n, s) => n + s.rows.length, 0);

  const [addingGroupId, setAddingGroupId] = useState<string | null>(null);

  // If a workspace has no Claude tabs at all, the user reaches "+ new agent"
  // from the always-visible empty-state row at the bottom — list every
  // workspace there so they can seed one anywhere.
  const emptyWorkspaces = useMemo(() => {
    return groupOrder
      .map((id) => groups.find((g) => g.id === id))
      .filter((g): g is NonNullable<typeof g> => Boolean(g))
      .filter((g) => !sections.some((s) => s.group.id === g.id));
  }, [groupOrder, groups, sections]);

  return (
    <Box h="100%" w="100%" bg="#010409" overflowY="auto">
      <Flex
        align="center"
        gap="2"
        px={isMobile ? '3' : '5'}
        py="3"
        borderBottom="1px solid #21262d"
        position="sticky"
        top="0"
        bg="#010409"
        zIndex={2}
      >
        <Bot size={18} strokeWidth={1.6} color="#c9d1d9" />
        <Text fontSize="15px" fontWeight={600} color="#f0f6fc">
          Agents
        </Text>
        <Text fontSize="12px" color="#7d8590">
          {totalCount} {totalCount === 1 ? 'session' : 'sessions'}
        </Text>
        {blockedCount > 0 && (
          <Text fontSize="12px" color="#ffa198" fontWeight={600}>
            · {blockedCount} blocked
          </Text>
        )}
      </Flex>

      <Box px={isMobile ? '2' : '4'} py="3">
        {sections.length === 0 && emptyWorkspaces.length === 0 && (
          <EmptyState />
        )}

        {sections.map(({ group, rows }) => (
          <Box key={group.id} mb="5">
            <WorkspaceHeader
              name={group.name}
              count={rows.length}
              onAdd={() => setAddingGroupId(group.id)}
              adding={addingGroupId === group.id}
            />
            <Box
              display="grid"
              gridTemplateColumns="repeat(auto-fit, minmax(280px, 360px))"
              gap="3"
              mt="2"
            >
              {rows.map((row) => (
                <AgentCard key={row.tab.id} row={row} />
              ))}
              {addingGroupId === group.id && (
                <NewAgentCard
                  groupId={group.id}
                  onDone={() => setAddingGroupId(null)}
                />
              )}
            </Box>
          </Box>
        ))}

        {emptyWorkspaces.length > 0 && (
          <Box mt="3">
            <Text fontSize="11px" color="#7d8590" mb="2" px="1">
              Empty workspaces
            </Text>
            <Box
              display="grid"
              gridTemplateColumns="repeat(auto-fit, minmax(380px, 1fr))"
              gap="3"
            >
              {emptyWorkspaces.map((g) => (
                <Box key={g.id}>
                  <WorkspaceHeader
                    name={g.name}
                    count={0}
                    onAdd={() => setAddingGroupId(g.id)}
                    adding={addingGroupId === g.id}
                    compact
                  />
                  {addingGroupId === g.id && (
                    <Box mt="2">
                      <NewAgentCard groupId={g.id} onDone={() => setAddingGroupId(null)} />
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function EmptyState() {
  return (
    <Flex direction="column" align="center" justify="center" py="20" color="#7d8590">
      <Bot size={48} strokeWidth={1.2} />
      <Text mt="3" fontSize="14px">
        No Claude sessions yet
      </Text>
      <Text fontSize="12px" color="#484f58">
        Create a workspace and start a Claude tab to see it here.
      </Text>
    </Flex>
  );
}

function WorkspaceHeader({
  name,
  count,
  onAdd,
  adding,
  compact,
}: {
  name: string;
  count: number;
  onAdd: () => void;
  adding: boolean;
  compact?: boolean;
}) {
  return (
    <Flex
      align="center"
      justify="space-between"
      px="1"
      py={compact ? '1' : '1.5'}
    >
      <Flex align="center" gap="2" minW="0">
        <Text fontSize={compact ? '12px' : '13px'} color="#f0f6fc" fontWeight={600} truncate>
          {name}
        </Text>
        {count > 0 && (
          <Text fontSize="11px" color="#7d8590">
            {count}
          </Text>
        )}
      </Flex>
      <Box
        as="button"
        aria-label={`Add agent to ${name}`}
        aria-disabled={adding}
        onClick={adding ? undefined : onAdd}
        opacity={adding ? 0.4 : 1}
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
        w="22px"
        h="22px"
        borderRadius="4px"
        color="#c9d1d9"
        bg="transparent"
        _hover={{ bg: '#21262d' }}
        style={{ border: 'none', cursor: adding ? 'default' : 'pointer', padding: 0 }}
      >
        <Plus size={14} strokeWidth={1.8} />
      </Box>
    </Flex>
  );
}

// Compact Claude-pane preview card: a header strip with label + status,
// a dark terminal-styled output region showing the last few lines of the
// agent's reply, and a rounded composer along the bottom (matches the
// mobile prompt textarea on the actual Claude tab).
function AgentCard({ row }: { row: AgentRow }) {
  const { tab, label, status, reply } = row;
  const colors = STATUS_COLOR[status];
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeAgentsView = useStore((s) => s.closeAgentsView);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current !== status) {
      setInput('');
      lastStatus.current = status;
    }
  }, [status]);

  // Auto-scroll the output to the bottom as new replies stream in so the
  // most recent line is always visible, mirroring how a real terminal tab
  // feels.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reply]);

  const navigate = () => {
    setActiveTab(tab.id);
    closeAgentsView();
  };

  const setPendingFirstMessage = useStore((s) => s.setPendingFirstMessage);
  const send = () => {
    const v = input.trim();
    if (!v) return;
    if (tab.kind === 'claude' && (status === 'idle' || status === 'done')) {
      // No live claude pty to write to — queue the message so it lands as
      // soon as the user opens the tab and claude boots/replays.
      setPendingFirstMessage(tab.id, v);
      setInput('');
      navigate();
      return;
    }
    void sendSessionInput(tab.id, v + '\r');
    setInput('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Allow follow-ups on done/idle Claude tabs too — typing here queues the
  // message via the same pendingFirstMessages path NewAgentCard uses, so a
  // finished agent can be re-prompted without first jumping to the tab.
  const canCompose = tab.kind === 'claude' || status === 'shell';
  // Keep only the last few lines of output — anything older is one tap away
  // on the actual tab and would just push the composer off the card.
  const lastLines = (reply?.trim() ?? '')
    .split('\n')
    .filter((l) => l.length > 0)
    .slice(-6)
    .join('\n');

  return (
    <Box
      bg="#0d1117"
      border="1px solid #21262d"
      borderLeftWidth={status === 'blocked' ? '2px' : '1px'}
      borderLeftColor={status === 'blocked' ? '#f85149' : '#21262d'}
      borderRadius="10px"
      overflow="hidden"
      display="flex"
      flexDirection="column"
      h="240px"
    >
      {/* Header strip — workspace label + status pill. Tap navigates to the
          real tab; keeps the gesture consistent with sidebar TabCards. */}
      <Flex
        align="center"
        justify="space-between"
        px="3"
        h="32px"
        flexShrink={0}
        cursor="pointer"
        onClick={navigate}
        _hover={{ bg: '#161b22' }}
      >
        <Flex align="center" gap="1.5" flex="1" minW="0" mr="2">
          <Box color="#79c0ff" flexShrink={0} display="inline-flex">
            <Sparkles size={12} strokeWidth={1.8} />
          </Box>
          <Text
            fontSize="12px"
            color="#f0f6fc"
            fontWeight={600}
            truncate
            title={label}
          >
            {label}
          </Text>
        </Flex>
        <Flex
          align="center"
          gap="1.5"
          px="1.5"
          py="0.5"
          borderRadius="999px"
          bg={colors.bg}
          flexShrink={0}
        >
          <Box
            w="6px"
            h="6px"
            borderRadius="999px"
            bg={colors.dot}
            style={
              status === 'working'
                ? { animation: 'grove-pulse 1.4s ease-in-out infinite' }
                : undefined
            }
          />
          <Text fontSize="10px" color={colors.text} fontWeight={600}>
            {STATUS_LABEL[status]}
          </Text>
        </Flex>
      </Flex>

      {/* Output area — same card background, monospace, bottom-aligned so
          newest content sits closest to the composer. */}
      <Box
        ref={outputRef}
        flex="1"
        px="3"
        py="2"
        overflow="hidden"
        fontFamily="var(--grove-mono)"
        fontSize="11px"
        lineHeight="1.45"
        color="#c9d1d9"
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
        }}
      >
        {lastLines ? (
          <Box>{lastLines}</Box>
        ) : (
          <Box color="#484f58" fontStyle="italic" fontSize="11px">
            {status === 'idle'
              ? 'Send a message below to start this agent.'
              : status === 'done'
                ? 'Session finished — send a follow-up to continue.'
                : status === 'working'
                  ? 'Working…'
                  : ''}
          </Box>
        )}
      </Box>

      {/* Composer — single rounded textarea; Enter sends, Shift+Enter for a
          newline. No send button: keeping the surface clean and matching the
          centered-omnibox style used elsewhere. */}
      <Box px="2" py="2" flexShrink={0}>
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            status === 'blocked'
              ? 'reply… (Enter to send)'
              : status === 'working'
                ? 'message… (Enter to send)'
                : status === 'shell'
                  ? 'run command… (Enter to send)'
                  : 'open tab to type'
          }
          disabled={!canCompose}
          rows={1}
          resize="none"
          minH="32px"
          maxH="96px"
          borderRadius="999px"
          px="3"
          py="1.5"
          fontSize="12px"
          fontFamily="var(--grove-mono)"
          bg="#010409"
          borderColor="#21262d"
          color="#c9d1d9"
          _placeholder={{ color: '#484f58' }}
          _focus={{ borderColor: '#1f6feb', boxShadow: '0 0 0 1px #1f6feb' }}
        />
      </Box>
    </Box>
  );
}

function NewAgentCard({ groupId, onDone }: { groupId: string; onDone: () => void }) {
  const [label, setLabel] = useState('');
  const newTab = useStore((s) => s.newTab);
  const setAgentLabel = useStore((s) => s.setAgentLabel);
  const setPendingFirstMessage = useStore((s) => s.setPendingFirstMessage);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  const start = () => {
    const v = label.trim();
    if (!v) return;
    // Create a Claude tab in the chosen workspace. claudeBootstrapTabs is set
    // by newTab() when mode==='claude', so TerminalView will auto-launch
    // `claude` once its WS attaches. The first user message rides the
    // pendingFirstMessages queue and is typed in by AgentsView's effect once
    // the agent-state ticker confirms claude is up.
    const tabId = newTab(groupId, v.slice(0, 40), { mode: 'claude' });
    setAgentLabel(tabId, v);
    setPendingFirstMessage(tabId, v);
    onDone();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      start();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDone();
    }
  };

  return (
    <Box
      bg="#0d1117"
      border="1px dashed #30363d"
      borderRadius="6px"
      p="3"
      display="flex"
      flexDirection="column"
      gap="2"
      minH="160px"
    >
      <Text fontSize="11px" color="#7d8590" fontWeight={600}>
        New agent
      </Text>
      <Textarea
        ref={taRef}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="What should this agent do?"
        rows={3}
        resize="none"
        fontSize="12px"
        fontFamily="var(--grove-mono)"
        bg="#010409"
        borderColor="#21262d"
        color="#c9d1d9"
        flex="1"
        _placeholder={{ color: '#484f58' }}
        _focus={{ borderColor: '#1f6feb', boxShadow: '0 0 0 1px #1f6feb' }}
      />
      <Flex gap="2" justify="flex-end">
        <Box
          as="button"
          onClick={onDone}
          display="inline-flex"
          alignItems="center"
          gap="1"
          px="2.5"
          py="1"
          borderRadius="4px"
          fontSize="12px"
          bg="transparent"
          color="#c9d1d9"
          _hover={{ bg: '#21262d' }}
          style={{ border: '1px solid #30363d', cursor: 'pointer' }}
        >
          <X size={12} strokeWidth={2} />
          Cancel
        </Box>
        <Box
          as="button"
          aria-disabled={!label.trim()}
          onClick={label.trim() ? start : undefined}
          opacity={label.trim() ? 1 : 0.5}
          display="inline-flex"
          alignItems="center"
          gap="1"
          px="2.5"
          py="1"
          borderRadius="4px"
          fontSize="12px"
          bg="#1f6feb"
          color="#fff"
          _hover={{ bg: '#388bfd' }}
          style={{
            border: 'none',
            cursor: label.trim() ? 'pointer' : 'default',
          }}
        >
          Start
        </Box>
      </Flex>
    </Box>
  );
}
