import { Box, Flex, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Highlight, themes, type Language } from 'prism-react-renderer';
import { Icon, addCollection } from '@iconify/react';
import materialIcons from '@iconify-json/material-icon-theme/icons.json';
import { useStore } from './store';

// Register the Material Icon Theme set once at module load. Iconify keeps it
// in memory so all <Icon icon="material-icon-theme:..."/> calls render
// without a network fetch.
addCollection(materialIcons as Parameters<typeof addCollection>[0]);

// Module-level home-dir cache. Filled by the first /env/home call; lets the
// frontend resolve `~/foo` paths to absolute without a per-render fetch.
let cachedHome: string | null = null;
fetch(`${API_BASE}/env/home`)
  .then((r) => r.json())
  .then((j) => {
    cachedHome = j.home ?? null;
  })
  .catch(() => {});

function resolveTilde(p: string): string {
  if (!cachedHome) return p;
  if (p === '~') return cachedHome;
  if (p.startsWith('~/')) return cachedHome + p.slice(1);
  return p;
}
import { useTabContext } from './useTabContext';
import { API_BASE } from './api';
import { SquareLoader } from './SquareLoader';

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  mtimeMs: number;
}
interface FilesResponse {
  cwd: string;
  shortCwd: string;
  parent: string | null;
  entries: FileEntry[];
  cwdReady: boolean;
}
interface FileContentResponse {
  content: string | null;
  truncated: boolean;
  size: number;
  error: string | null;
}
interface SearchHit {
  path: string;
  abs: string;
}
interface SearchResponse {
  cwdReady: boolean;
  root: string;
  results: SearchHit[];
}

const LIST_W = 240;
// Below this many pixels of panel width, switch to single-pane master-detail
// so the preview gets the full panel width while a file is open.
const NARROW_THRESHOLD = 520;
const DIR_CACHE_MAX = 64;

interface CacheEntry {
  ts: number;
  data: FilesResponse;
}

function relativeToBase(filePath: string, base: string): string {
  if (base && filePath.startsWith(base + '/')) return filePath.slice(base.length + 1);
  const idx = filePath.lastIndexOf('/');
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

export function FileBrowserPanel({
  forcedFullscreen = false,
  panelWidth,
}: {
  forcedFullscreen?: boolean;
  panelWidth: number;
}) {
  const activeTabId = useStore((s) => s.activeTabId);
  const closePanel = useStore((s) => s.closePanel);
  const togglePanelFullscreen = useStore((s) => s.togglePanelFullscreen);
  const fullscreen = useStore((s) => !!s.panelFullscreen.files);
  const togglePanel = closePanel;
  const toggleFullscreen = () => togglePanelFullscreen('files');
  const listOpen = useStore((s) => s.fileBrowserListOpen);
  const toggleList = useStore((s) => s.toggleFileBrowserList);
  const fileRequest = useStore((s) => s.fileBrowserRequest);
  const consumeRequest = useStore((s) => s.consumeFileBrowserRequest);
  const [path, setPath] = useState<string | null>(null);
  const [dir, setDir] = useState<FilesResponse | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContentResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Narrow viewports switch to a single-pane master-detail flow.
  const isNarrow = panelWidth < NARROW_THRESHOLD;
  const [narrowView, setNarrowView] = useState<'list' | 'preview'>('list');
  const ctx = useTabContext(activeTabId ?? '');
  // Path-keyed cache so re-visited folders render instantly. Bounded by an LRU
  // ts-ordering on overflow.
  const dirCache = useRef<Map<string, CacheEntry>>(new Map());

  function getCached(key: string): FilesResponse | null {
    const hit = dirCache.current.get(key);
    if (!hit) return null;
    hit.ts = Date.now();
    return hit.data;
  }
  function setCached(key: string, data: FilesResponse) {
    const cache = dirCache.current;
    cache.set(key, { ts: Date.now(), data });
    if (cache.size > DIR_CACHE_MAX) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, v] of cache)
        if (v.ts < oldestTs) {
          oldestTs = v.ts;
          oldestKey = k;
        }
      if (oldestKey) cache.delete(oldestKey);
    }
  }

  // Follow the tab's cwd: a new tab or a `cd` in the terminal drops manual
  // navigation. Clear caches too — files may have changed.
  useEffect(() => {
    setPath(null);
    setSelectedFile(null);
    setNarrowView('list');
    setDir(null);
    setDirError(null);
    setQuery('');
    setSearchOpen(false);
    setSearchResults(null);
    dirCache.current.clear();
  }, [activeTabId, ctx?.shortCwd]);

  useEffect(() => {
    setSelectedFile(null);
    setFileContent(null);
  }, [path]);

  // Wait for the shell to publish its cwd before fetching the default listing
  // — otherwise /files falls back to ~ and the user sees their home directory
  // instead of the session's actual working dir.
  const cwdReady = path !== null || (ctx?.cwdReady ?? false);

  useEffect(() => {
    if (!activeTabId || !cwdReady) return;
    const cacheKey = `${activeTabId}::${path ?? ''}::${path ? '' : (ctx?.shortCwd ?? '')}`;
    const cached = getCached(cacheKey);
    if (cached) {
      setDir(cached);
      setDirError(null);
    }
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ tabId: activeTabId });
        if (path) params.set('path', path);
        const res = await fetch(`${API_BASE}/files?${params.toString()}`);
        const json: FilesResponse = await res.json();
        if (cancelled) return;
        if (!json.cwdReady) return; // shell still spinning up; retry on next ctx tick
        setCached(cacheKey, json);
        setDir(json);
        setDirError(null);
      } catch (err) {
        if (!cancelled) setDirError(String((err as Error).message || err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTabId, path, cwdReady, ctx?.shortCwd]);

  useEffect(() => {
    const q = query.trim();
    if (!q || !activeTabId) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ tabId: activeTabId, q });
        const res = await fetch(`${API_BASE}/files/search?${params.toString()}`);
        const json: SearchResponse = await res.json();
        if (!cancelled) setSearchResults(json.results ?? []);
      } catch (err) {
        if (!cancelled) console.error('[grove] file search failed', err);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [activeTabId, query]);

  useEffect(() => {
    if (!selectedFile || !activeTabId) {
      setFileContent(null);
      setFileLoading(false);
      return;
    }
    // Clear the previous file's content immediately so the user never sees an
    // unrelated preview flash while the new file is being fetched.
    setFileContent(null);
    setFileLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ tabId: activeTabId, path: selectedFile });
        const res = await fetch(`${API_BASE}/file/content?${params.toString()}`);
        const json: FileContentResponse = await res.json();
        if (!cancelled) setFileContent(json);
      } catch (err) {
        if (!cancelled)
          setFileContent({
            content: null,
            truncated: false,
            size: 0,
            error: String((err as Error).message || err),
          });
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTabId, selectedFile]);

  const workspaceCwd = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === activeTabId);
    return tab ? (s.groups.find((g) => g.id === tab.groupId)?.cwd ?? null) : null;
  });
  const rows: ListRow[] = useMemo(() => {
    const out: ListRow[] = [];
    // Hide ".." once we're at the workspace root so navigation can't escape
    // above the tab's anchor. Compare resolved-absolute paths (the backend
    // already returns dir.cwd absolute; expand tilde on the workspaceCwd
    // via the home dir we cached at startup).
    const wsResolved = workspaceCwd ? resolveTilde(workspaceCwd) : null;
    const atWorkspaceRoot = wsResolved != null && dir?.cwd === wsResolved;
    if (dir?.parent && !atWorkspaceRoot) {
      out.push({
        kind: 'parent',
        entry: { name: '..', path: dir.parent, isDir: true, size: null, mtimeMs: 0 },
      });
    }
    if (dir) for (const e of dir.entries) out.push({ kind: 'entry', entry: e });
    return out;
  }, [dir, workspaceCwd]);

  // In narrow mode, only one pane is visible; in wide mode both are visible
  // when listOpen is true, otherwise just the preview takes over.
  const showList = isNarrow ? narrowView === 'list' : listOpen;
  const showPreview = isNarrow ? narrowView === 'preview' : true;

  function selectFile(p: string) {
    // Clear synchronously so the next render swaps straight to the loader
    // instead of briefly painting the new path against the previous file's
    // content while the useEffect-driven fetch is still mounting.
    setSelectedFile(p);
    setFileContent(null);
    setFileLoading(true);
    if (isNarrow) setNarrowView('preview');
  }
  function backToList() {
    setNarrowView('list');
  }

  // Honor cmd+click requests from terminal blocks. For directories we just
  // navigate. For files we navigate to the parent AND stash a `pendingSelect`
  // — the [path] reset effect would otherwise clear selectedFile right after
  // we set it.
  useEffect(() => {
    if (!fileRequest) return;
    const p = fileRequest.path;
    if (fileRequest.kind === 'dir') {
      setPath(p);
      setSelectedFile(null);
    } else {
      const slash = p.lastIndexOf('/');
      const parent = slash > 0 ? p.slice(0, slash) : null;
      if (parent && parent !== (dir?.cwd ?? null)) {
        setPath(parent);
        setPendingSelect(p);
      } else {
        selectFile(p);
      }
    }
    consumeRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileRequest?.nonce]);

  // Apply the pending selection once the requested directory has actually
  // loaded (so the file row is visible in the list when we highlight it).
  useEffect(() => {
    if (!pendingSelect || !dir?.cwd) return;
    const slash = pendingSelect.lastIndexOf('/');
    const parent = slash > 0 ? pendingSelect.slice(0, slash) : '';
    if (parent !== dir.cwd) return;
    selectFile(pendingSelect);
    setPendingSelect(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir?.cwd, pendingSelect]);

  return (
    <Flex direction="column" h="100%" w="100%" bg="#0d1117" minW="0" overflow="hidden">
      <Flex
        h="36px"
        flexShrink={0}
        align="center"
        px="2"
        gap="1.5"
        borderBottom="1px solid #21262d"
      >
        {isNarrow && narrowView === 'preview' ? (
          <HeaderIconButton title="Back to file list" onClick={backToList}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
              <path
                d="M7.5 2.5L3 6l4.5 3.5"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </HeaderIconButton>
        ) : (
          <HeaderIconButton
            title={listOpen ? 'Hide file list' : 'Show file list'}
            active={listOpen}
            onClick={toggleList}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <rect x="2" y="3" width="12" height="10" rx="1.5" strokeWidth="1.2" />
              <line x1="6" y1="3.5" x2="6" y2="12.5" strokeWidth="1.2" />
            </svg>
          </HeaderIconButton>
        )}
        <Text
          fontFamily="var(--grove-mono)"
          fontSize="12px"
          color="#7d8590"
          truncate
          minW="0"
          flex="1"
          title={selectedFile || dir?.cwd}
        >
          {selectedFile
            ? `${relativeToBase(selectedFile, dir?.cwd ?? '')}${fileContent?.truncated ? ' · truncated' : ''}`
            : (dir?.shortCwd ?? '…')}
        </Text>
        <Flex gap="1" flexShrink={0} align="center">
          <HeaderIconButton
            title={searchOpen ? 'Hide search' : 'Search files'}
            active={searchOpen}
            onClick={() => {
              const next = !searchOpen;
              setSearchOpen(next);
              if (!next) {
                setQuery('');
                setSearchResults(null);
              }
            }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor">
              <circle cx="6" cy="6" r="3.5" strokeWidth="1.3" />
              <path d="M9 9l3 3" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </HeaderIconButton>
          {!forcedFullscreen && (
            <HeaderIconButton
              title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              onClick={toggleFullscreen}
            >
              {fullscreen ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
                  <path
                    d="M10 2L6.5 5.5M6.5 5.5V2.5M6.5 5.5H9.5M2 10l3.5-3.5M5.5 6.5v3M5.5 6.5h-3"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
                  <path
                    d="M7 2h3v3M10 2L6.5 5.5M5 10H2V7M2 10l3.5-3.5"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </HeaderIconButton>
          )}
          <HeaderIconButton title="Close" onClick={togglePanel}>
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </HeaderIconButton>
        </Flex>
      </Flex>

      <Flex flex="1" minH="0" minW="0">
        {showList && (
          <Box
            flexShrink={0}
            w={isNarrow ? '100%' : `${LIST_W}px`}
            borderRight={!isNarrow ? '1px solid #21262d' : '1px solid transparent'}
            overflow="hidden"
            bg="#0d1117"
            minW="0"
            display="flex"
            flexDirection="column"
          >
            {searchOpen && (
              <SearchInput
                value={query}
                onChange={setQuery}
                searching={searching}
                onClose={() => {
                  setSearchOpen(false);
                  setQuery('');
                  setSearchResults(null);
                }}
              />
            )}
            <Box flex="1" minH="0" overflow="hidden">
              {query.trim() ? (
                <SearchResults
                  results={searchResults}
                  searching={searching}
                  selectedFile={selectedFile}
                  onPick={selectFile}
                />
              ) : (
                <>
                  {dirError && (
                    <Text px="3" py="2" fontSize="12px" color="#f85149">
                      {dirError}
                    </Text>
                  )}
                  {!dir && !dirError && (
                    <Flex h="100%" align="center" justify="center">
                      <SquareLoader />
                    </Flex>
                  )}
                  {dir && rows.length === 0 && !dirError && (
                    <Text px="3" py="2" fontSize="12px" color="#7d8590">
                      Empty folder.
                    </Text>
                  )}
                  {rows.length > 0 && (
                    <Virtuoso
                      style={{ height: '100%' }}
                      totalCount={rows.length}
                      itemContent={(idx) => {
                        const r = rows[idx];
                        return (
                          <FileRow
                            entry={r.entry}
                            selected={
                              r.kind === 'entry' && !r.entry.isDir && selectedFile === r.entry.path
                            }
                            onClick={
                              r.entry.isDir
                                ? () => setPath(r.entry.path)
                                : () => selectFile(r.entry.path)
                            }
                          />
                        );
                      }}
                    />
                  )}
                </>
              )}
            </Box>
          </Box>
        )}

        {showPreview && (
          <Box flex="1" minW="0" overflow="hidden" position="relative">
            <FilePreview file={selectedFile} content={fileContent} loading={fileLoading} />
          </Box>
        )}
      </Flex>
    </Flex>
  );
}

interface ListRow {
  kind: 'parent' | 'entry';
  entry: FileEntry;
}

function SearchInput({
  value,
  onChange,
  searching,
  onClose,
}: {
  value: string;
  onChange: (v: string) => void;
  searching: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Flex
      align="center"
      h="28px"
      flexShrink={0}
      px="2"
      gap="1.5"
      borderBottom="1px solid #21262d"
      bg="#0d1117"
    >
      <Box
        w="12px"
        h="12px"
        color="#7d8590"
        flexShrink={0}
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
      >
        {searching ? (
          <SquareLoader />
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
            <circle cx="5" cy="5" r="3" strokeWidth="1.3" />
            <path d="M8 8l2.5 2.5" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        )}
      </Box>
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Search files…"
        spellCheck={false}
        autoCorrect="off"
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: '#c9d1d9',
          fontFamily: 'var(--grove-mono)',
          fontSize: 12,
        }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          title="Clear"
          style={{
            background: 'transparent',
            border: 'none',
            color: '#7d8590',
            cursor: 'pointer',
            padding: 0,
            width: 16,
            height: 16,
            borderRadius: 3,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </Flex>
  );
}

function SearchResults({
  results,
  searching,
  selectedFile,
  onPick,
}: {
  results: SearchHit[] | null;
  searching: boolean;
  selectedFile: string | null;
  onPick: (abs: string) => void;
}) {
  if (results === null && searching) {
    return (
      <Flex h="100%" align="center" justify="center">
        <SquareLoader />
      </Flex>
    );
  }
  if (results !== null && results.length === 0) {
    return (
      <Text px="3" py="2" fontSize="12px" color="#7d8590">
        No matches.
      </Text>
    );
  }
  if (!results) return null;
  return (
    <Virtuoso
      style={{ height: '100%' }}
      totalCount={results.length}
      itemContent={(idx) => {
        const r = results[idx];
        const slash = r.path.lastIndexOf('/');
        const name = slash >= 0 ? r.path.slice(slash + 1) : r.path;
        const dir = slash >= 0 ? r.path.slice(0, slash) : '';
        return (
          <Flex
            align="center"
            px="2"
            h="32px"
            gap="1.5"
            cursor="pointer"
            bg={selectedFile === r.abs ? '#1f6feb33' : 'transparent'}
            borderLeft={selectedFile === r.abs ? '2px solid #1f6feb' : '2px solid transparent'}
            _hover={{ bg: selectedFile === r.abs ? '#1f6feb44' : '#161b22' }}
            onClick={() => onPick(r.abs)}
          >
            <Box
              w="14px"
              h="14px"
              flexShrink={0}
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
            >
              <Icon
                icon={iconNameForFile(r.path.split('/').pop() || r.path)}
                width="14"
                height="14"
                style={{ display: 'block' }}
              />
            </Box>
            <Box flex="1" minW="0">
              <Text
                fontFamily="var(--grove-mono)"
                fontSize="12px"
                color="#c9d1d9"
                truncate
                title={r.path}
              >
                {name}
              </Text>
              {dir && (
                <Text fontFamily="var(--grove-mono)" fontSize="10px" color="#7d8590" truncate>
                  {dir}
                </Text>
              )}
            </Box>
          </Flex>
        );
      }}
    />
  );
}

function FilePreview({
  file,
  content,
  loading,
}: {
  file: string | null;
  content: FileContentResponse | null;
  loading: boolean;
}) {
  if (!file) {
    return (
      <Flex h="100%" align="center" justify="center" px="4">
        <Text fontSize="12px" color="#7d8590">
          Select a file to preview
        </Text>
      </Flex>
    );
  }
  if (loading && !content) {
    return (
      <Flex h="100%" align="center" justify="center">
        <SquareLoader />
      </Flex>
    );
  }
  if (content?.error) {
    return (
      <Flex h="100%" align="center" justify="center" px="4">
        <Text fontSize="12px" color="#f85149">
          {content.error}
        </Text>
      </Flex>
    );
  }
  const text = content?.content ?? '';
  const language = detectLanguage(file);
  return (
    <Box
      h="100%"
      minH="0"
      overflow="auto"
      bg="#010409"
      fontFamily="var(--grove-mono)"
      fontSize="12px"
      lineHeight="1.5"
      color="#c9d1d9"
    >
      <Highlight code={text} language={language} theme={themes.vsDark}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <Box as="pre" m="0" p="0" style={{ whiteSpace: 'pre', background: 'transparent' }}>
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line });
              return (
                <Box
                  key={i}
                  display="flex"
                  px="0"
                  style={lineProps.style}
                  className={lineProps.className}
                >
                  <Box
                    flexShrink={0}
                    w="44px"
                    textAlign="right"
                    pr="3"
                    color="#484f58"
                    userSelect="none"
                    style={{ whiteSpace: 'pre' }}
                  >
                    {i + 1}
                  </Box>
                  <Box flex="1" minW="0" style={{ whiteSpace: 'pre' }}>
                    {line.map((token, j) => {
                      const tp = getTokenProps({ token });
                      // Render whitespace as visible glyphs so the user can
                      // tell tabs from spaces. We only mark token content,
                      // not the syntactic spacing between tokens — that's
                      // already correctly rendered by the browser.
                      const rendered = renderWithWhitespace(token.content);
                      return (
                        <span key={j} className={tp.className} style={tp.style}>
                          {rendered}
                        </span>
                      );
                    })}
                  </Box>
                </Box>
              );
            })}
          </Box>
        )}
      </Highlight>
    </Box>
  );
}

// Visible glyphs for tab and space. Rendered as muted overlay chars so the
// code stays readable but indentation is unambiguous.
function renderWithWhitespace(s: string): React.ReactNode {
  if (!s) return s;
  if (s.indexOf('\t') === -1 && s.indexOf(' ') === -1) return s;
  const parts: React.ReactNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      parts.push(buf);
      buf = '';
    }
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\t') {
      flush();
      parts.push(
        <span key={`t${i}`} style={{ color: '#30363d' }}>
          →{'\t'}
        </span>,
      );
    } else if (c === ' ') {
      flush();
      parts.push(
        <span key={`s${i}`} style={{ color: '#21262d' }}>
          ·
        </span>,
      );
    } else {
      buf += c;
    }
  }
  flush();
  return parts;
}

// Map filename to a Prism language id. prism-react-renderer ships ~20 langs
// out of the box; falls back to plain rendering for unknown extensions.
function detectLanguage(file: string | null): Language {
  if (!file) return 'tsx';
  const lower = file.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts')) return 'typescript';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
    return 'javascript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rb')) return 'ruby';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.kt')) return 'kotlin';
  if (lower.endsWith('.swift')) return 'swift';
  if (lower.endsWith('.c') || lower.endsWith('.h')) return 'c';
  if (lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.hpp')) return 'cpp';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.scss') || lower.endsWith('.sass')) return 'scss';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'markup';
  if (lower.endsWith('.xml') || lower.endsWith('.svg')) return 'markup';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) return 'bash';
  if (lower.endsWith('dockerfile') || lower.endsWith('.dockerfile')) return 'docker';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.graphql') || lower.endsWith('.gql')) return 'graphql';
  return 'tsx';
}

function FileRow({
  entry,
  onClick,
  selected,
}: {
  entry: FileEntry;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <Flex
      align="center"
      px="2"
      h="24px"
      gap="1.5"
      cursor={onClick ? 'pointer' : 'default'}
      bg={selected ? '#1f6feb33' : 'transparent'}
      borderLeft={selected ? '2px solid #1f6feb' : '2px solid transparent'}
      _hover={onClick ? { bg: selected ? '#1f6feb44' : '#161b22' } : undefined}
      onClick={onClick}
    >
      <Box
        w="14px"
        h="14px"
        flexShrink={0}
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
      >
        {entry.isDir ? (
          <FolderIcon />
        ) : (
          <Icon
            icon={iconNameForFile(entry.name)}
            width="14"
            height="14"
            style={{ display: 'block' }}
          />
        )}
      </Box>
      <Text
        flex="1"
        minW="0"
        truncate
        fontFamily="var(--grove-mono)"
        fontSize="12px"
        color={entry.isDir ? '#c9d1d9' : '#c9d1d9'}
      >
        {entry.name}
      </Text>
    </Flex>
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

function FolderIcon() {
  return (
    <svg
      width="14"
      height="12"
      viewBox="0 0 14 12"
      fill="none"
      stroke="#79c0ff"
      style={{ display: 'block' }}
    >
      <path
        d="M1 2.5a1 1 0 0 1 1-1h3.5l1.5 1.5h5a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2.5z"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Map a filename to a Material Icon Theme icon key. Iconify renders these
// via the bundled material-icon-theme collection. Unknown files fall back
// to the generic "document" icon — still a real file glyph, just neutral.
function iconNameForFile(name: string): string {
  const lower = name.toLowerCase();
  // Whole-filename specials beat extension rules.
  const fullMap: Record<string, string> = {
    'package.json': 'nodejs',
    'package-lock.json': 'nodejs',
    'yarn.lock': 'yarn',
    'pnpm-lock.yaml': 'pnpm',
    'tsconfig.json': 'tsconfig',
    'tsconfig.base.json': 'tsconfig',
    'vite.config.ts': 'vite',
    'vite.config.js': 'vite',
    'webpack.config.js': 'webpack',
    'rollup.config.js': 'rollup',
    'esbuild.config.js': 'esbuild',
    'babel.config.js': 'babel',
    '.babelrc': 'babel',
    '.eslintrc': 'eslint',
    '.eslintrc.js': 'eslint',
    '.eslintrc.json': 'eslint',
    '.prettierrc': 'prettier',
    '.prettierrc.json': 'prettier',
    dockerfile: 'docker',
    '.dockerignore': 'docker',
    'docker-compose.yml': 'docker',
    'docker-compose.yaml': 'docker',
    makefile: 'makefile',
    '.gitignore': 'git',
    '.gitattributes': 'git',
    '.gitmodules': 'git',
    '.editorconfig': 'editorconfig',
    '.npmrc': 'npm',
    '.nvmrc': 'nodejs',
    'readme.md': 'readme',
    license: 'certificate',
    'license.md': 'certificate',
    'cargo.toml': 'rust',
    'cargo.lock': 'rust',
    'go.mod': 'go',
    'go.sum': 'go',
    gemfile: 'ruby',
    'gemfile.lock': 'ruby',
    'pyproject.toml': 'python',
    'requirements.txt': 'python',
    pipfile: 'python',
    'pipfile.lock': 'python',
  };
  if (fullMap[lower]) return `material-icon-theme:${fullMap[lower]}`;

  // Match `.env`, `.env.local`, `.env.production`, etc.
  if (lower === '.env' || lower.startsWith('.env.')) return 'material-icon-theme:tune';

  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const extMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'react-ts',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'react',
    json: 'json',
    jsonl: 'json',
    json5: 'json', // jsonl/json5 fall back to json
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'settings',
    ini: 'settings',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'mdx',
    py: 'python',
    pyc: 'python',
    pyi: 'python',
    ipynb: 'jupyter',
    rb: 'ruby',
    erb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    scala: 'scala',
    swift: 'swift',
    cs: 'csharp',
    fs: 'fsharp',
    fsi: 'fsharp',
    c: 'c',
    h: 'h',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'hpp',
    php: 'php',
    blade: 'php',
    lua: 'lua',
    dart: 'dart',
    vue: 'vue',
    svelte: 'svelte',
    elm: 'elm',
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    hrl: 'erlang',
    r: 'r',
    sql: 'database',
    graphql: 'graphql',
    gql: 'graphql',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'svg',
    css: 'css',
    scss: 'sass',
    sass: 'sass',
    less: 'less',
    postcss: 'postcss',
    sh: 'console',
    bash: 'console',
    zsh: 'console',
    fish: 'console',
    ps1: 'powershell',
    csv: 'table',
    tsv: 'table',
    xlsx: 'table',
    xls: 'table',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    ico: 'image',
    avif: 'image',
    bmp: 'image',
    mp3: 'audio',
    wav: 'audio',
    flac: 'audio',
    ogg: 'audio',
    mp4: 'video',
    mov: 'video',
    webm: 'video',
    mkv: 'video',
    pdf: 'pdf',
    zip: 'zip',
    tar: 'zip',
    gz: 'zip',
    bz2: 'zip',
    '7z': 'zip',
    rar: 'zip',
    dmg: 'zip',
    woff: 'font',
    woff2: 'font',
    ttf: 'font',
    otf: 'font',
    eot: 'font',
    txt: 'document',
    log: 'log',
  };
  if (extMap[ext]) return `material-icon-theme:${extMap[ext]}`;
  return 'material-icon-theme:document';
}
