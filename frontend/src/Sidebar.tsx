import { Box, Flex, HStack, Input, Text } from '@chakra-ui/react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { useTabContext, subscribeAllTabContexts } from './useTabContext';
import { API_BASE } from './api';
import { Tooltip } from './Tooltip';
import { shortPath } from './paths';
import { GitFork } from 'lucide-react';
import {
  BranchIcon,
  ChevronIcon,
  CloseIcon,
  FolderIcon,
  KebabIcon,
  PlusIcon,
  StopIcon,
  TerminalIcon,
} from './icons';

// Returns the current branch of a workspace's cwd. Seeded by a single
// /context fetch on mount, then kept fresh by piggybacking on the per-tab
// WebSocket ctx pushes — any tab in the same worktree (matching repoRoot)
// reports the same branch as the workspace itself.
function useWorkspaceBranch(groupId: string, cwd: string, enabled: boolean): string | null {
  const [state, setState] = useState<{ branch: string | null; repoRoot: string | null }>({
    branch: null,
    repoRoot: null,
  });
  useEffect(() => {
    if (!enabled || !cwd) {
      setState({ branch: null, repoRoot: null });
      return;
    }
    let cancelled = false;
    // One-shot seed: gives us the initial branch + the workspace's repoRoot
    // so subsequent tab pushes can be matched.
    fetch(`${API_BASE}/context?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setState({ branch: data.branch ?? null, repoRoot: data.repoRoot ?? null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cwd, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const unsub = subscribeAllTabContexts((tabId, ctx) => {
      // Only listen to tabs that belong to this workspace (matches groupId)
      // AND are sitting inside the same worktree (matches repoRoot). A
      // worktree pins exactly one branch, so any such tab is authoritative.
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.groupId !== groupId) return;
      setState((prev) => {
        if (!prev.repoRoot || ctx.repoRoot !== prev.repoRoot) return prev;
        if (ctx.branch === prev.branch) return prev;
        return { ...prev, branch: ctx.branch };
      });
    });
    return unsub;
  }, [groupId, enabled]);

  return state.branch;
}

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
      const groupsOnly = args.droppableContainers.filter((c) => String(c.id).startsWith('group:'));
      return closestCenter({ ...args, droppableContainers: groupsOnly });
    }
    return closestCenter(args);
  };

  return (
    <ColorPopupContext.Provider
      value={{ openTabId: colorPopupTabId, setOpenTabId: setColorPopupTabId }}
    >
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

function SidebarIconButton({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isSorting } =
    useSortable({
      id: `group:${group.id}`,
    });
  const tabs = useStore((s) => s.tabs);
  const tabOrderByGroup = useStore((s) => s.tabOrderByGroup);
  const toggleGroup = useStore((s) => s.toggleGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const newTab = useStore((s) => s.newTab);
  const forkGroup = useStore((s) => s.forkGroup);
  const closeFork = useStore((s) => s.closeFork);
  const sourceName = useStore((s) =>
    group.forkedFromId ? (s.groups.find((g) => g.id === group.forkedFromId)?.name ?? null) : null,
  );
  // Show a repo badge next to fork names when the user has forks across more
  // than one repo — otherwise the badge would be redundant clutter. Slug is
  // derived from `~/.grove/worktrees/<slug>/<name>/` which the main process
  // creates at fork time.
  const [editingCwd, setEditingCwd] = useState(false);
  const setGroupCwd = useStore((s) => s.setGroupCwd);
  const autoEditCwdGroupId = useStore((s) => s.autoEditCwdGroupId);
  const setAutoEditCwdGroupId = useStore((s) => s.setAutoEditCwdGroupId);
  const justDraggedRef = useRef(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; danger: boolean } | null>(
    null,
  );
  const isFork = !!group.forkedFromId;
  // The workspace owns its branch; tabs that match this branch suppress their
  // chip so the sidebar isn't repeating the same `main` four times.
  const workspaceBranch = useWorkspaceBranch(group.id, group.cwd, !group.collapsed);
  // grove/ is implicit when the workspace itself is a fork.
  const workspaceBranchShort =
    workspaceBranch && isFork && workspaceBranch.startsWith('grove/')
      ? workspaceBranch.slice('grove/'.length)
      : workspaceBranch;
  // Suppress the chip when it would just echo the workspace name — common for
  // forks sitting on their original grove/<slug> branch.
  const showWorkspaceBranchChip = !!workspaceBranchShort && workspaceBranchShort !== group.name;
  // Forks are always backed by git; non-forks only know once main has resolved
  // the cwd. `null` = unknown, `true`/`false` = resolved.
  const [isGit, setIsGit] = useState<boolean | null>(isFork ? true : null);

  useEffect(() => {
    if (!menuPos || isGit !== null) return;
    let cancelled = false;
    window.grove?.workspace?.isGitRepo({ cwd: group.cwd }).then((ok) => {
      if (!cancelled) setIsGit(!!ok);
    });
    return () => {
      cancelled = true;
    };
  }, [menuPos, isGit, group.cwd]);

  // Re-evaluate if the cwd changes (user edited the folder).
  useEffect(() => {
    if (!isFork) setIsGit(null);
  }, [group.cwd, isFork]);

  // Current branch lookup for the menu's Copy branch entry. Forks use their
  // recorded forkBranch so the menu shows the grove/* slug even after the
  // user `git switch`es inside the worktree; non-forks fetch the live branch
  // from the backend's /context endpoint.
  const [menuBranch, setMenuBranch] = useState<string | null>(group.forkBranch ?? null);
  const [copyBranchBusy, setCopyBranchBusy] = useState(false);

  async function fetchBranch(): Promise<string | null> {
    try {
      const r = await fetch(`${API_BASE}/context?cwd=${encodeURIComponent(group.cwd)}`);
      if (!r.ok) return null;
      const data = await r.json();
      return data?.branch ?? null;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    if (!menuPos || isFork) return;
    let cancelled = false;
    fetchBranch().then((b) => {
      if (!cancelled) setMenuBranch(b);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuPos, isFork, group.cwd]);

  async function handleCopyBranch() {
    if (menuBranch) {
      navigator.clipboard.writeText(menuBranch);
      setMenuPos(null);
      return;
    }
    setCopyBranchBusy(true);
    const b = await fetchBranch();
    setCopyBranchBusy(false);
    if (b) {
      setMenuBranch(b);
      navigator.clipboard.writeText(b);
      setMenuPos(null);
    }
    // If still null, the cwd isn't actually a git repo right now — silently
    // leave the menu open so the user can see the item is disabled.
  }

  async function handleFork() {
    setMenuPos(null);
    const res = await forkGroup(group.id);
    if ('error' in res) {
      // eslint-disable-next-line no-alert
      window.alert(`Fork failed: ${res.error}`);
    }
  }

  async function handleCloseWorkspace(force = false) {
    setMenuPos(null);
    // Non-forks are pure renderer state — Grove never wrote anything to git on
    // their behalf, so removing them needs no main-process round trip.
    if (!isFork) {
      removeGroup(group.id);
      return;
    }
    const res = await closeFork(group.id, force);
    if ('error' in res) {
      // eslint-disable-next-line no-alert
      window.alert(`Close workspace failed: ${res.error}`);
      return;
    }
    if ('needsConfirm' in res) {
      const { status } = res;
      const dirty = status.hasUncommitted || status.hasUnpushed;
      const branchInfo = status.currentBranch ? ` on ${status.currentBranch}` : '';
      let msg: string;
      if (dirty) {
        const parts: string[] = [];
        if (status.hasUncommitted) parts.push('uncommitted changes');
        if (status.hasUnpushed)
          parts.push(
            `${status.unpushedCount} unpushed commit${status.unpushedCount === 1 ? '' : 's'}`,
          );
        msg = `This workspace has ${parts.join(' and ')}${branchInfo}. The worktree directory and the grove/* branch will be deleted — this work cannot be recovered.`;
      } else {
        msg = `No uncommitted changes${branchInfo}. The worktree directory and its grove/* branch will be removed.`;
      }
      setConfirmDialog({ message: msg, danger: dirty });
    }
  }

  useEffect(() => {
    if (autoEditCwdGroupId === group.id) {
      pickFolder();
      setAutoEditCwdGroupId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditCwdGroupId, group.id]);

  useEffect(() => {
    if (!menuPos) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('[data-group-menu]')) setMenuPos(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuPos]);

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
      const t = setTimeout(() => {
        justDraggedRef.current = false;
      }, 250);
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
    <Box ref={setNodeRef} style={style} mb="2" position="relative">
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
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenuPos({ top: r.bottom + 4, left: Math.max(8, r.right - 220) });
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
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
        >
          {isFork ? <GitFork size={14} strokeWidth={1.4} /> : <FolderIcon />}
        </Box>
        <Box flex="1" minW="0">
          {editingCwd ? (
            <Input
              size="xs"
              defaultValue={group.cwd}
              autoFocus
              placeholder="~/path/to/folder"
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                setGroupCwd(group.id, e.target.value || group.cwd);
                setEditingCwd(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setGroupCwd(group.id, (e.target as HTMLInputElement).value || group.cwd);
                  setEditingCwd(false);
                }
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
            <Tooltip label={shortPath(group.cwd)}>
              <Text fontSize="12px" color="#c9d1d9" fontWeight="500" truncate lineHeight="1.4">
                {group.name}
              </Text>
            </Tooltip>
          )}
        </Box>
        {showWorkspaceBranchChip && !editingCwd && !hovered && (
          <Tooltip label={workspaceBranch ?? ''}>
            <Box
              flexShrink={0}
              px="1.5"
              py="0.5"
              maxW="100px"
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
            >
              <Box flexShrink={0} display="inline-flex" alignItems="center">
                <BranchIcon />
              </Box>
              <Box truncate minW="0">
                {workspaceBranchShort}
              </Box>
            </Box>
          </Tooltip>
        )}
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
            onClick={(e) => {
              e.stopPropagation();
              newTab(group.id);
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#7d8590',
              cursor: 'pointer',
              width: 20,
              height: 20,
              borderRadius: 4,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            <PlusIcon />
          </button>
          <button
            title={isFork ? 'Close workspace' : 'Delete workspace'}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleCloseWorkspace(false);
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#7d8590',
              cursor: 'pointer',
              width: 20,
              height: 20,
              borderRadius: 4,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
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
                <TabCard key={t.id} tab={t} workspaceBranch={workspaceBranch} />
              ))}
            </Flex>
          </SortableContext>
        </CollapsePanel>
      )}
      {isFork && groupTabs.length === 0 && !group.collapsed && (
        <Box pt="1" pb="1" pl="8" pr="2">
          <Text fontSize="11px" color="#7d8590" lineHeight="1.5">
            Fresh workspace{sourceName ? ` from ${sourceName}` : ''}. Hover this row and click + to
            add a tab.
          </Text>
        </Box>
      )}
      {confirmDialog &&
        createPortal(
          <Box
            position="fixed"
            inset="0"
            bg="rgba(0,0,0,0.5)"
            zIndex={2000}
            display="flex"
            alignItems="center"
            justifyContent="center"
            onClick={() => setConfirmDialog(null)}
          >
            <Box
              bg="#161b22"
              border="1px solid #30363d"
              borderRadius="8px"
              boxShadow="0 20px 60px rgba(0,0,0,0.6)"
              w="440px"
              p="4"
              onClick={(e) => e.stopPropagation()}
            >
              <Text fontSize="14px" color="#f0f6fc" fontWeight="600" mb="2">
                Close {group.name}?
              </Text>
              <Text fontSize="12px" color="#c9d1d9" mb="4" lineHeight="1.5" whiteSpace="pre-wrap">
                {confirmDialog.message}
              </Text>
              <Flex justify="flex-end" gap="2">
                <button
                  onClick={() => setConfirmDialog(null)}
                  style={{
                    background: 'transparent',
                    border: '1px solid #30363d',
                    color: '#c9d1d9',
                    cursor: 'pointer',
                    padding: '6px 14px',
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setConfirmDialog(null);
                    handleCloseWorkspace(true);
                  }}
                  style={
                    confirmDialog.danger
                      ? {
                          background: '#da3633',
                          border: '1px solid #f85149',
                          color: '#fff',
                          cursor: 'pointer',
                          padding: '6px 14px',
                          borderRadius: 4,
                          fontSize: 12,
                          fontWeight: 600,
                        }
                      : {
                          background: '#1f6feb',
                          border: '1px solid #388bfd',
                          color: '#fff',
                          cursor: 'pointer',
                          padding: '6px 14px',
                          borderRadius: 4,
                          fontSize: 12,
                          fontWeight: 600,
                        }
                  }
                >
                  {confirmDialog.danger ? 'Discard and close' : 'Close workspace'}
                </button>
              </Flex>
            </Box>
          </Box>,
          document.body,
        )}
      {menuPos &&
        createPortal(
          <Box
            data-group-menu
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
            <TabMenuItem
              onClick={isGit === false ? () => {} : handleFork}
              disabled={isGit === false}
              hint={isGit === false ? 'Not a git repository' : undefined}
            >
              Fork workspace
            </TabMenuItem>
            <Box borderTop="1px solid #30363d" my="1" />
            <TabMenuItem
              onClick={() => {
                navigator.clipboard.writeText(group.cwd);
                setMenuPos(null);
              }}
            >
              Copy working directory
            </TabMenuItem>
            {isGit !== false && (
              <TabMenuItem
                onClick={copyBranchBusy ? () => {} : handleCopyBranch}
                disabled={copyBranchBusy}
              >
                {copyBranchBusy ? 'Copying branch…' : 'Copy branch'}
              </TabMenuItem>
            )}
            <Box borderTop="1px solid #30363d" my="1" />
            <TabMenuItem
              onClick={() => {
                if (window.grove?.revealPath) window.grove.revealPath(group.cwd);
                setMenuPos(null);
              }}
            >
              Open in Finder
            </TabMenuItem>
            <Box borderTop="1px solid #30363d" my="1" />
            <TabMenuItem onClick={() => handleCloseWorkspace(false)} danger>
              Close workspace
            </TabMenuItem>
          </Box>,
          document.body,
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
        <Box
          w="20px"
          h="20px"
          color="#7d8590"
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
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
        <Text
          fontSize="12px"
          color={isDefault ? '#f0f6fc' : COLOR_HEX[t.color]}
          truncate
          lineHeight="1.4"
        >
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

function TabCard({ tab, workspaceBranch }: { tab: Tab; workspaceBranch: string | null }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `tab:${tab.id}`,
  });
  const active = useStore((s) => s.activeTabId === tab.id);
  const unread = useStore((s) => !!s.unreadTabs[tab.id]);
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

  const rawBranch = ctx?.branch ?? null;
  const isFork = !!group?.forkedFromId;
  // Inside a fork the `grove/` prefix is implied by the workspace itself,
  // so the chip drops it to leave room for the slug (otter-a3f2).
  const branch =
    isFork && rawBranch?.startsWith('grove/') ? rawBranch.slice('grove/'.length) : rawBranch;
  const isDefault = tab.color === 'default';
  const flexElRef = useRef<HTMLElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!showColors) {
      setMenuPos(null);
      return;
    }
    const el = flexElRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: Math.max(8, r.right - 220) });
  }, [showColors]);

  return (
    <>
      <Flex
        ref={(el) => {
          setNodeRef(el);
          ref.current = el;
          flexElRef.current = el;
        }}
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
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpenTabId(tab.id);
        }}
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
          onClick={
            runningCmd
              ? (e: React.MouseEvent) => {
                  e.stopPropagation();
                  fetch(`${API_BASE}/session/${tab.id}/input`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: '\x03' }),
                  }).catch(() => {});
                }
              : undefined
          }
          _hover={runningCmd ? { color: '#f85149' } : undefined}
          position="relative"
        >
          {runningCmd ? <StopIcon /> : <TerminalIcon />}
          {unread && (
            <Box
              position="absolute"
              top="-2px"
              right="-2px"
              w="7px"
              h="7px"
              borderRadius="full"
              bg={COLOR_HEX.red}
              border="1.5px solid #0d1117"
              aria-label="Long command finished"
            />
          )}
        </Box>

        <Box flex="1" minW="0">
          {editing ? (
            <Input
              size="xs"
              defaultValue={tab.title}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                renameTab(tab.id, e.target.value || tab.title);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  renameTab(tab.id, (e.target as HTMLInputElement).value || tab.title);
                  setEditing(false);
                }
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
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
              truncate
              lineHeight="1.4"
            >
              {tab.title}
            </Text>
          )}
        </Box>
        {branch && rawBranch !== workspaceBranch && !hovered && !showColors && !runningCmd && (
          <Tooltip label={branch}>
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
            >
              <Box flexShrink={0} display="inline-flex" alignItems="center">
                <BranchIcon />
              </Box>
              <Box truncate minW="0">
                {branch}
              </Box>
            </Box>
          </Tooltip>
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
              onClick={(e) => {
                e.stopPropagation();
                toggleColors();
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#7d8590',
                cursor: 'pointer',
                width: 20,
                height: 20,
                borderRadius: 4,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
              }}
            >
              <KebabIcon />
            </button>
            <button
              title="Close"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#7d8590',
                cursor: 'pointer',
                width: 20,
                height: 20,
                borderRadius: 4,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
              }}
            >
              <CloseIcon />
            </button>
          </HStack>
        )}
      </Flex>
      {showColors &&
        menuPos &&
        createPortal(
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
            <TabMenuItem
              onClick={() => {
                navigator.clipboard.writeText(ctx?.shortCwd || group?.cwd || '');
                setOpenTabId(null);
              }}
            >
              Copy working directory
            </TabMenuItem>
            {branch && (
              <TabMenuItem
                onClick={() => {
                  navigator.clipboard.writeText(branch);
                  setOpenTabId(null);
                }}
              >
                Copy branch
              </TabMenuItem>
            )}
            <Box borderTop="1px solid #30363d" my="1" />
            <TabMenuItem
              onClick={() => {
                closeTab(tab.id);
                setOpenTabId(null);
              }}
              danger
            >
              Close
            </TabMenuItem>
            <Box borderTop="1px solid #30363d" my="1" />
            <Flex gap="1" px="2" py="1" justify="space-between">
              {COLOR_ORDER.map((c) => (
                <button
                  key={c}
                  title={c}
                  onClick={(e) => {
                    e.stopPropagation();
                    setColor(tab.id, c);
                    setOpenTabId(null);
                  }}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    background: COLOR_HEX[c],
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

function TabMenuItem({
  children,
  onClick,
  danger,
  disabled,
  hint,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Box
      px="3"
      py="1.5"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      onClick={disabled ? undefined : onClick}
      _hover={disabled ? undefined : { bg: danger ? '#f8514922' : '#1f6feb' }}
      opacity={disabled ? 0.5 : 1}
      title={hint}
    >
      <Text fontSize="12px" color={danger ? '#f85149' : '#f0f6fc'}>
        {children}
      </Text>
      {hint && disabled && (
        <Text fontSize="11px" color="#7d8590" mt="0.5">
          {hint}
        </Text>
      )}
    </Box>
  );
}
