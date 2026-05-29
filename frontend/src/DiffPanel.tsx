import { Box, Flex, HStack, Text } from '@chakra-ui/react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { API_BASE } from './api';
import { SquareLoader } from './SquareLoader';
import { Icon } from '@iconify/react';
import { Highlight, themes, type Language } from 'prism-react-renderer';
import { iconNameForFile } from './fileIcon';
import { detectLanguage } from './codeLanguage';

interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'unknown';
  added: number;
  removed: number;
  patch: string;
  binary: boolean;
}

interface DiffResponse {
  repoRoot: string | null;
  branch: string | null;
  files: DiffFile[];
  total: { added: number; removed: number; files: number };
}

const FILE_LIST_W = 220;

function fileAnchorId(path: string) {
  return `grove-diff-file-${encodeURIComponent(path)}`;
}

interface ParsedHunk {
  headerLine: string;
  oldStart: number;
  newStart: number;
  newCount: number;
  body: string[];
}

interface NumberedLine {
  line: string;
  oldLn: number | null;
  newLn: number | null;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunks(patch: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let cur: ParsedHunk | null = null;
  for (const line of patch.split('\n')) {
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      if (cur) hunks.push(cur);
      cur = {
        headerLine: line,
        oldStart: parseInt(m[1], 10),
        newStart: parseInt(m[3], 10),
        newCount: m[4] ? parseInt(m[4], 10) : 1,
        body: [],
      };
    } else if (cur) {
      const ch = line[0];
      if (ch === ' ' || ch === '+' || ch === '-' || ch === '\\' || line === '') {
        cur.body.push(line);
      }
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// Annotate each body line with its old/new line number. Context lines bump
// both counters; '+' bumps only new; '-' bumps only old. '\' (no-newline
// markers) and empty lines inherit nothing.
function numberBody(body: string[], oldStart: number, newStart: number): NumberedLine[] {
  const out: NumberedLine[] = [];
  let oldLn = oldStart;
  let newLn = newStart;
  for (const line of body) {
    const ch = line[0];
    if (ch === '+') {
      out.push({ line, oldLn: null, newLn });
      newLn++;
    } else if (ch === '-') {
      out.push({ line, oldLn, newLn: null });
      oldLn++;
    } else if (ch === ' ' || line === '') {
      out.push({ line, oldLn, newLn });
      oldLn++;
      newLn++;
    } else {
      out.push({ line, oldLn: null, newLn: null });
    }
  }
  return out;
}

// Slice the body of a hunk so only lines whose new-file line number falls in
// [from, to] are kept. Deletion lines (no new line number) inherit the most
// recent in-range state, so adjacent `-` lines accompany the context they
// replaced.
function sliceHunkBody(hunk: ParsedHunk, from: number, to: number): NumberedLine[] {
  const numbered = numberBody(hunk.body, hunk.oldStart, hunk.newStart);
  const result: NumberedLine[] = [];
  let inRange = false;
  for (const nl of numbered) {
    if (nl.newLn !== null) {
      inRange = nl.newLn >= from && nl.newLn <= to;
    }
    if (inRange) result.push(nl);
  }
  return result;
}

export function DiffPanel({
  forcedFullscreen = false,
  paneId,
}: {
  forcedFullscreen?: boolean;
  paneId?: string;
}) {
  const activeTabId = useStore((s) => s.activeTabId);
  const setPaneState = useStore((s) => s.setPaneState);
  // Per-pane file-list-open. Falls back to the legacy global so panes that
  // pre-date the v3 migration (no pane-scoped state yet) still respect the
  // user's existing toggle.
  const fileListOpen = useStore((s) => {
    if (paneId) {
      const ps = s.paneState[paneId];
      if (ps && ps.kind === 'diff' && typeof ps.fileListOpen === 'boolean') return ps.fileListOpen;
    }
    return s.diffFileListOpen;
  });
  const toggleFileList = () => {
    if (paneId) setPaneState(paneId, { kind: 'diff', fileListOpen: !fileListOpen });
    else useStore.getState().toggleDiffFileList();
  };
  void forcedFullscreen;
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // fullPatches caches the full-context patch keyed by path. The cached
  // value's `signature` tracks the polled patch it was derived from so we
  // can drop stale entries after the user edits the file and the polled
  // patch shifts.
  const [fullPatches, setFullPatches] = useState<
    Record<string, { signature: string; patch: string }>
  >({});
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(new Set());
  const [loadingGap, setLoadingGap] = useState<string | null>(null);
  const inFlightFullPatch = useRef<Map<string, Promise<string | null>>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Drop cached full patches whose polled signature no longer matches —
  // happens when a file's HEAD diff changes mid-session.
  useEffect(() => {
    if (!data) return;
    setFullPatches((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const f of data.files) {
        const hit = prev[f.path];
        if (hit && hit.signature === f.patch) next[f.path] = hit;
        else if (hit) changed = true;
      }
      // Also drop entries for files no longer in the response.
      for (const path of Object.keys(prev)) {
        if (!(path in next) && !data.files.some((f) => f.path === path)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [data]);

  // Latest values referenced from stable callbacks. Keeps the toggle / gap
  // callbacks identity-stable so memo'd children don't re-render on every
  // parent change.
  const latest = useRef({ fullPatches, activeTabId });
  latest.current = { fullPatches, activeTabId };
  const ensureFullPatch = useCallback(
    async (path: string, signature: string): Promise<string | null> => {
      const { fullPatches: cur, activeTabId: tabId } = latest.current;
      const hit = cur[path];
      if (hit && hit.signature === signature) return hit.patch;
      const inFlight = inFlightFullPatch.current.get(path);
      if (inFlight) return inFlight;
      if (!tabId) return null;
      const promise = (async () => {
        try {
          const res = await fetch(
            `${API_BASE}/diff/file?tabId=${encodeURIComponent(tabId)}&path=${encodeURIComponent(path)}`,
          );
          const json = await res.json();
          const patch: string | undefined = json?.file?.patch;
          if (patch) setFullPatches((prev) => ({ ...prev, [path]: { signature, patch } }));
          return patch ?? null;
        } catch (err) {
          console.error('[grove] failed to fetch full diff', path, err);
          return null;
        } finally {
          inFlightFullPatch.current.delete(path);
        }
      })();
      inFlightFullPatch.current.set(path, promise);
      return promise;
    },
    [],
  );

  async function toggleAllGapsForFile(path: string, signature: string, hunkCount: number) {
    const keys: string[] = [];
    for (let i = 0; i <= hunkCount; i++) keys.push(`${path}:${i}`);
    const anyExpanded = keys.some((k) => expandedGaps.has(k));
    if (anyExpanded) {
      setExpandedGaps((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.delete(k);
        return next;
      });
      return;
    }
    const allKey = `${path}:*`;
    setLoadingGap(allKey);
    try {
      const full = await ensureFullPatch(path, signature);
      if (!full) return;
      setExpandedGaps((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.add(k);
        return next;
      });
    } finally {
      setLoadingGap((cur) => (cur === allKey ? null : cur));
    }
  }

  // Stable handler so FileDiffView (memo'd below) doesn't see a new function
  // identity on every parent render — re-rendering the diff hunks on a
  // fileListOpen toggle would otherwise take >1s on big diffs.
  const toggleGap = useCallback(async (path: string, gapIndex: number, signature: string) => {
    const key = `${path}:${gapIndex}`;
    let didDelete = false;
    setExpandedGaps((prev) => {
      if (!prev.has(key)) return prev;
      didDelete = true;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (didDelete) return;
    setLoadingGap(key);
    try {
      const full = await ensureFullPatch(path, signature);
      if (!full) return;
      setExpandedGaps((prev) => new Set(prev).add(key));
    } finally {
      setLoadingGap((cur) => (cur === key ? null : cur));
    }
  }, []);

  function toggleCollapsed(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  useEffect(() => {
    if (!activeTabId) return;
    let cancelled = false;
    async function refresh() {
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/diff?tabId=${encodeURIComponent(activeTabId!)}`);
        const json: DiffResponse = await res.json();
        if (!cancelled) setData(json);
      } catch {
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    refresh();
    const id = setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeTabId]);

  function scrollToFile(path: string) {
    const root = scrollRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`#${CSS.escape(fileAnchorId(path))}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <Flex direction="column" h="100%" w="100%" bg="#0d1117" minW="0" overflow="hidden">
      <HeaderRow px="2" gap="3">
        <HeaderIconButton
          title={fileListOpen ? 'Hide file list' : 'Show file list'}
          active={fileListOpen}
          onClick={toggleFileList}
        >
          <FileListIcon />
        </HeaderIconButton>
        <Text fontSize="12px" color="#c9d1d9" fontWeight="600" flexShrink={0}>
          Code review
        </Text>
        {data?.branch && (
          <Text
            fontSize="12px"
            color="#7ee787"
            fontFamily="var(--grove-mono)"
            truncate
            minW="0"
            title={data.branch}
          >
            {data.branch}
          </Text>
        )}
        {data && data.total.files > 0 && (
          <HStack gap="1.5" fontSize="12px" fontFamily="var(--grove-mono)" flexShrink={0}>
            <Text color="#7d8590">{data.total.files}f</Text>
            {data.total.added > 0 && <Text color="#7ee787">+{data.total.added}</Text>}
            {data.total.removed > 0 && <Text color="#ff7b72">-{data.total.removed}</Text>}
          </HStack>
        )}
        <Box flex="1" minW="0" />
      </HeaderRow>

      <Flex flex="1" minH="0" minW="0" position="relative" overflow="hidden">
        <Box
          flexShrink={0}
          w={fileListOpen ? `${FILE_LIST_W}px` : '0px'}
          borderRight={fileListOpen ? '1px solid #21262d' : '1px solid transparent'}
          overflow="hidden"
          bg="#0d1117"
          style={{
            transition: 'width 240ms cubic-bezier(0.22, 0.61, 0.36, 1), border-color 240ms ease',
            willChange: 'width',
          }}
        >
          <Box w={`${FILE_LIST_W}px`} h="100%" overflowY="auto">
            {!data && loading && (
              <Text px="3" py="2" fontSize="12px" color="#7d8590">
                Loading…
              </Text>
            )}
            {data && data.files.length === 0 && (
              <Text px="3" py="2" fontSize="12px" color="#7d8590">
                {data.repoRoot ? 'No changes.' : 'Not a git repo.'}
              </Text>
            )}
            {data?.files.map((f) => (
              <FileRow key={f.path} file={f} onClick={() => scrollToFile(f.path)} />
            ))}
          </Box>
        </Box>

        <Box ref={scrollRef} flex="1" overflowY="auto" minW="0">
          {!data && loading && (
            <Text px="3" py="3" fontSize="12px" color="#7d8590">
              Loading…
            </Text>
          )}
          {data && !data.repoRoot && (
            <Text px="3" py="3" fontSize="12px" color="#7d8590">
              Not a git repository.
            </Text>
          )}
          {data && data.repoRoot && data.files.length === 0 && (
            <Text px="3" py="3" fontSize="12px" color="#7d8590">
              No uncommitted changes.
            </Text>
          )}
          {data?.files.map((f) => {
            const isCollapsed = collapsed.has(f.path);
            const fileHunkCount = parseHunks(f.patch).length;
            const fileAllExpanded =
              fileHunkCount > 0 &&
              Array.from({ length: fileHunkCount + 1 }, (_, i) => `${f.path}:${i}`).some((k) =>
                expandedGaps.has(k),
              );
            const fileExpandLoading = loadingGap === `${f.path}:*`;
            return (
              <Box key={f.path} id={fileAnchorId(f.path)}>
                <HeaderRow
                  sticky
                  cursor="pointer"
                  _hover={{ bg: '#161b22' }}
                  onClick={() => toggleCollapsed(f.path)}
                >
                  <IconSlot
                    color="#7d8590"
                    style={{
                      transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                      transition: 'transform 160ms ease',
                    }}
                  >
                    <ChevronIcon />
                  </IconSlot>
                  <IconSlot title={statusLabel(f.status)}>
                    <Icon
                      icon={iconNameForFile(f.path.split('/').pop() || f.path)}
                      width="14"
                      height="14"
                      style={{ display: 'block' }}
                    />
                  </IconSlot>
                  <Text
                    as="span"
                    fontFamily="var(--grove-mono)"
                    fontSize="12px"
                    color="#c9d1d9"
                    truncate
                    minW="0"
                    flex="1"
                    title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                  >
                    {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                  </Text>
                  <ExpandAllButton
                    isExpanded={fileAllExpanded}
                    isLoading={fileExpandLoading}
                    onClick={() => toggleAllGapsForFile(f.path, f.patch, fileHunkCount)}
                  />
                  <CopyFileButton path={f.path} />
                  <HStack
                    gap="1.5"
                    fontSize="12px"
                    fontFamily="var(--grove-mono)"
                    flexShrink={0}
                    lineHeight="1"
                  >
                    {f.added > 0 && <Text color="#7ee787">+{f.added}</Text>}
                    {f.removed > 0 && <Text color="#ff7b72">-{f.removed}</Text>}
                  </HStack>
                </HeaderRow>
                {!isCollapsed && (
                  <FileDiffView
                    file={f}
                    fullPatch={fullPatches[f.path]?.patch ?? null}
                    expandedGaps={expandedGaps}
                    loadingGap={loadingGap}
                    toggleGap={toggleGap}
                  />
                )}
              </Box>
            );
          })}
        </Box>
      </Flex>
    </Flex>
  );
}

function FileRow({ file, onClick }: { file: DiffFile; onClick: () => void }) {
  const name = file.path.split('/').pop() ?? file.path;
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  return (
    <Flex
      align="flex-start"
      px="2"
      py="1.5"
      gap="1.5"
      cursor="pointer"
      _hover={{ bg: '#161b22' }}
      onClick={onClick}
      borderLeft="2px solid transparent"
    >
      <Box flex="1" minW="0">
        <Flex align="center" gap="1.5" minW="0">
          <Box
            flexShrink={0}
            display="flex"
            alignItems="center"
            title={statusLabel(file.status)}
          >
            <Icon
              icon={iconNameForFile(name)}
              width="14"
              height="14"
              style={{ display: 'block' }}
            />
          </Box>
          <Text
            fontFamily="var(--grove-mono)"
            fontSize="12px"
            color="#c9d1d9"
            truncate
            title={file.path}
          >
            {name}
          </Text>
        </Flex>
        {dir && (
          <Text fontFamily="var(--grove-mono)" fontSize="12px" color="#7d8590" truncate pl="18px">
            {dir}
          </Text>
        )}
      </Box>
      <HStack gap="1" fontSize="12px" fontFamily="var(--grove-mono)" flexShrink={0} pt="1px">
        {file.added > 0 && <Text color="#7ee787">+{file.added}</Text>}
        {file.removed > 0 && <Text color="#ff7b72">-{file.removed}</Text>}
      </HStack>
    </Flex>
  );
}

function statusLabel(s: DiffFile['status']): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const HEADER_ROW_H = '36px';

function HeaderRow({
  children,
  sticky,
  px = '3',
  gap = '2',
  cursor,
  onClick,
  _hover,
}: {
  children: React.ReactNode;
  sticky?: boolean;
  px?: string;
  gap?: string;
  cursor?: string;
  onClick?: () => void;
  _hover?: { bg?: string };
}) {
  return (
    <Flex
      align="center"
      px={px}
      h={HEADER_ROW_H}
      flexShrink={0}
      gap={gap}
      bg="#0d1117"
      borderBottom="1px solid #21262d"
      position={sticky ? 'sticky' : undefined}
      top={sticky ? '-1px' : undefined}
      zIndex={sticky ? 1 : undefined}
      cursor={cursor as 'pointer' | undefined}
      _hover={_hover}
      onClick={onClick}
      lineHeight="1"
      css={{
        // Give every text node a 14px line box so Flex's `align="center"`
        // lands them on the same baseline as the 14px icons. Avoid forcing
        // inline-flex — it disables `text-overflow: ellipsis` on truncated
        // file paths.
        '& p, & span': {
          margin: 0,
          lineHeight: '14px',
        },
      }}
    >
      {children}
    </Flex>
  );
}

function IconSlot({
  children,
  color,
  title,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <Flex
      align="center"
      justify="center"
      flexShrink={0}
      w="14px"
      h="14px"
      color={color}
      title={title}
      style={style}
    >
      {children}
    </Flex>
  );
}

function ExpandAllButton({
  isExpanded,
  isLoading,
  onClick,
}: {
  isExpanded: boolean;
  isLoading: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={isLoading}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={isLoading ? 'Loading…' : isExpanded ? 'Collapse all hunks' : 'Expand all hunks'}
      style={{
        background: hover ? '#21262d' : 'transparent',
        border: 'none',
        color: hover ? '#c9d1d9' : '#7d8590',
        cursor: isLoading ? 'wait' : 'pointer',
        padding: 0,
        width: 22,
        height: 22,
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      <Box w="14px" h="14px" display="inline-flex" alignItems="center" justifyContent="center">
        {isLoading ? (
          <SquareLoader />
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
            {isExpanded ? (
              <path
                d="M3.5 2L6 4.5L8.5 2M3.5 10L6 7.5L8.5 10"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <path
                d="M3.5 4L6 1.5L8.5 4M3.5 8L6 10.5L8.5 8"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
        )}
      </Box>
    </button>
  );
}

function CopyFileButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);
  return (
    <button
      title={copied ? 'Copied' : `Copy "${path}"`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(path)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {});
      }}
      style={{
        background: hover ? '#21262d' : 'transparent',
        border: 'none',
        color: copied ? '#7ee787' : hover ? '#c9d1d9' : '#7d8590',
        cursor: 'pointer',
        padding: 0,
        width: 22,
        height: 22,
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 120ms ease, color 120ms ease',
        flexShrink: 0,
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      style={{ display: 'block' }}
    >
      <path
        d="M3.5 5.5L7 9L10.5 5.5"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="5" y="5" width="9" height="10" rx="1.4" strokeWidth="1.3" strokeLinejoin="round" />
      <path
        d="M11 5V2.5a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <path
        d="M3 8.5L6.5 12L13 4.5"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface Gap {
  from: number;
  to: number | null;
}

const FileDiffView = memo(_FileDiffView);

function _FileDiffView({
  file,
  fullPatch,
  expandedGaps,
  loadingGap,
  toggleGap,
}: {
  file: DiffFile;
  fullPatch: string | null;
  expandedGaps: Set<string>;
  loadingGap: string | null;
  toggleGap: (path: string, gapIndex: number, signature: string) => void;
}) {
  const onToggleGap = useCallback(
    (gapIndex: number) => toggleGap(file.path, gapIndex, file.patch),
    [toggleGap, file.path, file.patch],
  );
  const hunks = useMemo(() => parseHunks(file.patch), [file.patch]);
  const language = useMemo(() => detectLanguage(file.path), [file.path]);
  const fullHunk = useMemo(() => (fullPatch ? parseHunks(fullPatch)[0] : null), [fullPatch]);
  const gaps = useMemo<Gap[]>(() => {
    const out: Gap[] = hunks.map((h, i) => {
      const prev = hunks[i - 1];
      return { from: prev ? prev.newStart + prev.newCount : 1, to: h.newStart - 1 };
    });
    if (hunks.length > 0) {
      const last = hunks[hunks.length - 1];
      out.push({ from: last.newStart + last.newCount, to: null });
    }
    return out;
  }, [hunks]);

  if (file.binary) {
    return (
      <Text px="3" py="2" fontSize="12px" color="#7d8590">
        Binary file — diff hidden.
      </Text>
    );
  }
  if (!file.patch) return null;

  return (
    <Box
      className="grove-diff-scroll"
      bg="#010409"
      fontFamily="var(--grove-mono)"
      fontSize="12px"
      lineHeight="1.5"
      overflowX="auto"
    >
      {/* Inner wrapper width: max-content so per-line gutter/tint backgrounds
          extend across the full horizontal scroll, not just the viewport. */}
      <Box style={{ width: 'max-content', minWidth: '100%' }}>
        {hunks.map((h, i) => {
          const key = `${file.path}:${i}`;
          const gap = gaps[i];
          const isExpanded = expandedGaps.has(key);
          const expandable = isExpanded || gap.to === null || gap.from <= gap.to;
          const expandedLines =
            isExpanded && fullHunk
              ? sliceHunkBody(fullHunk, gap.from, gap.to ?? Number.MAX_SAFE_INTEGER)
              : null;
          const numberedBody = numberBody(h.body, h.oldStart, h.newStart);
          return (
            <Fragment key={i}>
              {expandedLines?.map((nl, j) => (
                <DiffLine key={j} nl={nl} language={language} />
              ))}
              <HunkHeaderLine
                text={h.headerLine}
                isExpandable={expandable}
                isExpanded={isExpanded}
                isLoading={loadingGap === key}
                onToggle={() => onToggleGap(i)}
              />
              {numberedBody.map((nl, j) => (
                <DiffLine key={j} nl={nl} language={language} />
              ))}
            </Fragment>
          );
        })}
        {hunks.length > 0 &&
          (() => {
            const i = hunks.length;
            const key = `${file.path}:${i}`;
            const isExpanded = expandedGaps.has(key);
            const expandedLines =
              isExpanded && fullHunk
                ? sliceHunkBody(fullHunk, gaps[i].from, Number.MAX_SAFE_INTEGER)
                : null;
            return (
              <>
                {expandedLines?.map((nl, j) => (
                  <DiffLine key={j} nl={nl} language={language} />
                ))}
                <HunkToggleRow
                  isExpanded={isExpanded}
                  isLoading={loadingGap === key}
                  onToggle={() => onToggleGap(i)}
                />
              </>
            );
          })()}
      </Box>
    </Box>
  );
}

function HunkHeaderLine({
  text,
  isExpandable,
  isExpanded,
  isLoading,
  onToggle,
}: {
  text: string;
  isExpandable: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  onToggle: () => void;
}) {
  return (
    <Flex
      bg="rgba(56, 139, 253, 0.12)"
      color="#79c0ff"
      minH="18px"
      pl="9px"
      pr="12px"
      align="center"
      style={{ borderLeft: '3px solid #1f6feb' }}
      cursor={isExpandable ? (isLoading ? 'wait' : 'pointer') : 'default'}
      onClick={isExpandable && !isLoading ? onToggle : undefined}
      _hover={isExpandable ? { bg: 'rgba(56, 139, 253, 0.2)' } : undefined}
    >
      {isExpandable && (
        <Box
          w="12px"
          h="12px"
          flexShrink={0}
          mr="6px"
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
        >
          {isLoading ? (
            <SquareLoader />
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
              {isExpanded ? (
                <path
                  d="M3.5 2L6 4.5L8.5 2M3.5 10L6 7.5L8.5 10"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <path
                  d="M3.5 4L6 1.5L8.5 4M3.5 8L6 10.5L8.5 8"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          )}
        </Box>
      )}
      <Box as="span" whiteSpace="pre" flex="1" minW="0">
        {text || ' '}
      </Box>
    </Flex>
  );
}

function HunkToggleRow({
  isExpanded,
  isLoading,
  onToggle,
}: {
  isExpanded: boolean;
  isLoading: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={isLoading}
      title={isLoading ? 'Loading…' : isExpanded ? 'Collapse context' : 'Expand context'}
      className="grove-gap-row"
      style={{
        background: 'transparent',
        border: 'none',
        cursor: isLoading ? 'wait' : 'pointer',
        color: '#79c0ff',
        padding: '2px 9px',
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        textAlign: 'left',
        borderLeft: '3px solid transparent',
      }}
    >
      <Box
        w="12px"
        h="12px"
        flexShrink={0}
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
      >
        {isLoading ? (
          <SquareLoader />
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
            {isExpanded ? (
              <path
                d="M3.5 2L6 4.5L8.5 2M3.5 10L6 7.5L8.5 10"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <path
                d="M3.5 4L6 1.5L8.5 4M3.5 8L6 10.5L8.5 8"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
        )}
      </Box>
    </button>
  );
}

function DiffLine({ nl, language }: { nl: NumberedLine; language: Language }) {
  const { line } = nl;
  let bg = 'transparent';
  let gutter = 'transparent';
  let prefix = '';
  let code = line;
  const isAdd = line.startsWith('+') && !line.startsWith('+++');
  const isDel = line.startsWith('-') && !line.startsWith('---');
  if (isAdd) {
    bg = 'rgba(126, 231, 135, 0.08)';
    gutter = '#3fb950';
    prefix = '+';
    code = line.slice(1);
  } else if (isDel) {
    bg = 'rgba(255, 123, 114, 0.08)';
    gutter = '#f85149';
    prefix = '-';
    code = line.slice(1);
  } else if (line.startsWith(' ')) {
    prefix = ' ';
    code = line.slice(1);
  }
  const prefixColor = isAdd ? '#7ee787' : isDel ? '#ff7b72' : '#6e7681';
  return (
    <Flex
      bg={bg}
      color="#c9d1d9"
      minH="18px"
      pr="12px"
      align="center"
      style={{ borderLeft: `3px solid ${gutter}` }}
    >
      <LineNumberGutter value={nl.oldLn} />
      <LineNumberGutter value={nl.newLn} />
      <Box as="span" whiteSpace="pre" flex="1" minW="0" pl="9px">
        <Box as="span" color={prefixColor} pr="2">
          {prefix}
        </Box>
        <HighlightedCode code={code} language={language} />
      </Box>
    </Flex>
  );
}

function LineNumberGutter({ value }: { value: number | null }) {
  return (
    <Box
      flexShrink={0}
      w="44px"
      pr="2"
      textAlign="right"
      color="#484f58"
      userSelect="none"
      fontFamily="var(--grove-mono)"
      style={{ whiteSpace: 'pre' }}
    >
      {value ?? ''}
    </Box>
  );
}

function HighlightedCode({ code, language }: { code: string; language: Language }) {
  if (!code) return <>{' '}</>;
  return (
    <Highlight code={code} language={language} theme={themes.vsDark}>
      {({ tokens, getTokenProps }) => (
        <>
          {tokens[0]?.map((token, j) => {
            const tp = getTokenProps({ token });
            return (
              <span key={j} className={tp.className} style={tp.style}>
                {token.content}
              </span>
            );
          })}
        </>
      )}
    </Highlight>
  );
}

function HeaderIconButton({
  children,
  title,
  onClick,
  active,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const bg = active ? '#30363d' : hover ? '#21262d' : 'transparent';
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        background: bg,
        border: 'none',
        color: '#c9d1d9',
        cursor: 'pointer',
        padding: 0,
        height: '24px',
        width: '24px',
        flexShrink: 0,
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 120ms ease',
      }}
    >
      {children}
    </button>
  );
}

function FileListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="2" y="3" width="12" height="10" rx="1.5" strokeWidth="1.2" />
      <line x1="6" y1="3.5" x2="6" y2="12.5" strokeWidth="1.2" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
      <path
        d="M7 2h3v3M10 2L6.5 5.5M5 10H2V7M2 10l3.5-3.5"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ContractIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
      <path
        d="M10 2L6.5 5.5M6.5 5.5V2.5M6.5 5.5H9.5M2 10l3.5-3.5M5.5 6.5v3M5.5 6.5h-3"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
