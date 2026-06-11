import { Box, Flex, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Icon } from '@iconify/react';
import { useStore } from './store';
import { iconNameForFile } from './fileIcon';
import {
  CodeMirrorEditor,
  type CodeMirrorHandle,
  type CursorPosition,
} from './codemirror/CodeMirrorEditor';

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
  paneId,
}: {
  forcedFullscreen?: boolean;
  panelWidth: number;
  paneId?: string;
}) {
  const activeTabId = useStore((s) => s.activeTabId);
  const setPaneState = useStore((s) => s.setPaneState);
  // Per-pane list-open state (with legacy global as fallback for trees that
  // pre-date paneState).
  const listOpen = useStore((s) => {
    if (paneId) {
      const ps = s.paneState[paneId];
      if (ps && ps.kind === 'files' && typeof ps.listOpen === 'boolean') return ps.listOpen;
    }
    return s.fileBrowserListOpen;
  });
  const toggleList = () => {
    if (paneId) setPaneState(paneId, { kind: 'files', listOpen: !listOpen });
    else useStore.getState().toggleFileBrowserList();
  };
  void forcedFullscreen;
  const fileRequest = useStore((s) => s.fileBrowserRequest);
  const consumeRequest = useStore((s) => s.consumeFileBrowserRequest);
  const [path, setPath] = useState<string | null>(null);
  const [dir, setDir] = useState<FilesResponse | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContentResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  // Target line/col + Claude-edit range to apply once the selected file's
  // content has been loaded. Set when the panel receives a `fileBrowserRequest`
  // and consumed by the editor effect; cleared after application so a future
  // re-render of the same file doesn't re-jump.
  const editorTargetRef = useRef<{
    path: string;
    line?: number;
    col?: number;
    claudeEditRange?: { fromLine: number; toLine: number };
  } | null>(null);
  const editorRef = useRef<CodeMirrorHandle>(null);
  const [cursorPos, setCursorPos] = useState<CursorPosition | null>(null);
  const [languageLabel, setLanguageLabel] = useState<string>('Plain Text');
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
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
    if (
      dirtyRef.current &&
      selectedFile &&
      selectedFile !== p &&
      !window.confirm('Discard unsaved changes?')
    ) {
      return;
    }
    // Clear synchronously so the next render swaps straight to the loader
    // instead of briefly painting the new path against the previous file's
    // content while the useEffect-driven fetch is still mounting.
    setSelectedFile(p);
    setFileContent(null);
    setFileLoading(true);
    setSaveError(null);
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
      // Stash line/col + Claude-edit range so the editor jumps to the right
      // spot once the content fetch resolves. Keyed by path so a late content
      // load for a different file doesn't accidentally apply the target.
      editorTargetRef.current = {
        path: p,
        line: fileRequest.line,
        col: fileRequest.col,
        claudeEditRange: fileRequest.claudeEditRange,
      };
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

  // Push the loaded file into CodeMirror. The target (line/col + Claude edit
  // range) is read from editorTargetRef and consumed exactly once — a second
  // re-render of the same file (e.g. the same path clicked twice in the tree)
  // shouldn't re-jump the cursor or re-show the highlight.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!selectedFile) {
      editor.clear();
      setCursorPos(null);
      return;
    }
    if (!fileContent) return; // still loading; FilePreview shows the loader
    if (fileContent.error || fileContent.content === null) {
      editor.clear();
      setCursorPos(null);
      return;
    }
    const target =
      editorTargetRef.current && editorTargetRef.current.path === selectedFile
        ? editorTargetRef.current
        : null;
    editorTargetRef.current = null;
    editor.openFile({
      path: selectedFile,
      content: fileContent.content,
      line: target?.line,
      col: target?.col,
      claudeEditRange: target?.claudeEditRange,
    });
    setCursorPos({ line: target?.line ?? 1, col: target?.col ?? 1 });
  }, [selectedFile, fileContent]);

  // ⌘G — prompt for a line number and jump. Only fires when the Files panel
  // is the active panel (the listener is mounted on the panel root, which
  // only renders when this panel is active in its pane).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!selectedFile) return;
      const isCmdG = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'g';
      if (!isCmdG) return;
      e.preventDefault();
      editorRef.current?.promptGotoLine();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedFile]);

  // ⌘S — save the active file to disk.
  useEffect(() => {
    async function save() {
      if (!selectedFile || !activeTabId) return;
      const editor = editorRef.current;
      if (!editor) return;
      if (fileContent?.truncated) {
        setSaveError('Cannot save: file was truncated on load');
        return;
      }
      const content = editor.getValue();
      try {
        const res = await fetch(`${API_BASE}/file/content`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tabId: activeTabId, path: selectedFile, content }),
        });
        const json = await res.json();
        if (!json.ok) {
          setSaveError(json.error || 'Save failed');
          return;
        }
        setSaveError(null);
        editor.markClean();
        // Refresh local size/mtime so the status bar's truncated indicator
        // stays accurate after a save.
        setFileContent((prev) =>
          prev ? { ...prev, content, size: json.size ?? prev.size } : prev,
        );
      } catch (err) {
        setSaveError(String((err as Error).message || err));
      }
    }
    function onKey(e: KeyboardEvent) {
      const isCmdS = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's';
      if (!isCmdS) return;
      if (!selectedFile) return;
      e.preventDefault();
      void save();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedFile, activeTabId, fileContent?.truncated]);

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
            title={
              isNarrow
                ? narrowView === 'list'
                  ? 'Show file preview'
                  : 'Show file list'
                : listOpen
                  ? 'Hide file list'
                  : 'Show file list'
            }
            active={isNarrow ? narrowView === 'list' : listOpen}
            onClick={() => {
              if (isNarrow) {
                setNarrowView((v) => (v === 'list' ? 'preview' : 'list'));
              } else {
                toggleList();
              }
            }}
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
          <Flex flex="1" direction="column" minW="0" overflow="hidden" position="relative">
            <Box flex="1" minH="0" minW="0" position="relative">
              <PreviewSurface
                file={selectedFile}
                content={fileContent}
                loading={fileLoading}
                editorRef={editorRef}
                onCursorChange={setCursorPos}
                onLanguageChange={setLanguageLabel}
                onDirtyChange={setDirty}
              />
            </Box>
            {selectedFile && (
              <StatusBar
                language={languageLabel}
                cursor={cursorPos}
                truncated={!!fileContent?.truncated}
                dirty={dirty}
                saveError={saveError}
              />
            )}
          </Flex>
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

// CodeMirror-backed preview. The editor view itself is mounted once and lives
// for the panel's lifetime — content swaps happen via the imperative handle
// (see the editor effect in FileBrowserPanel). This wrapper renders the
// loading / error / empty states layered above the editor; the editor stays
// underneath so the next file swap is instant rather than mount-flashing.
function PreviewSurface({
  file,
  content,
  loading,
  editorRef,
  onCursorChange,
  onLanguageChange,
  onDirtyChange,
}: {
  file: string | null;
  content: FileContentResponse | null;
  loading: boolean;
  editorRef: React.RefObject<CodeMirrorHandle>;
  onCursorChange: (p: CursorPosition) => void;
  onLanguageChange: (label: string) => void;
  onDirtyChange: (d: boolean) => void;
}) {
  const showEmpty = !file;
  const showLoader = !!file && loading && !content;
  const showError = !!content?.error;
  const tooLarge = !!file && !content?.error && content?.content === null;
  return (
    <Box position="relative" h="100%" w="100%">
      <Flex
        position="absolute"
        inset="0"
        direction="column"
        bg="#010409"
        // Hide the editor (instead of unmounting) while overlays show, so the
        // first paint after a swap is a fully-built view rather than a fresh
        // mount cycle.
        visibility={showEmpty || showError || tooLarge ? 'hidden' : 'visible'}
      >
        <CodeMirrorEditor
          ref={editorRef}
          onCursorChange={onCursorChange}
          onLanguageChange={onLanguageChange}
          onDirtyChange={onDirtyChange}
        />
      </Flex>
      {showEmpty && (
        <Flex position="absolute" inset="0" align="center" justify="center" px="4">
          <Text fontSize="12px" color="#7d8590">
            Select a file to preview
          </Text>
        </Flex>
      )}
      {showLoader && (
        <Flex position="absolute" inset="0" align="center" justify="center">
          <SquareLoader />
        </Flex>
      )}
      {showError && (
        <Flex position="absolute" inset="0" align="center" justify="center" px="4">
          <Text fontSize="12px" color="#f85149">
            {content!.error}
          </Text>
        </Flex>
      )}
      {tooLarge && (
        <Flex position="absolute" inset="0" align="center" justify="center" px="4">
          <Text fontSize="12px" color="#7d8590" textAlign="center">
            File too large to preview ({Math.round((content?.size ?? 0) / 1024)} KB).
          </Text>
        </Flex>
      )}
    </Box>
  );
}

function StatusBar({
  language,
  cursor,
  truncated,
  dirty,
  saveError,
}: {
  language: string;
  cursor: CursorPosition | null;
  truncated: boolean;
  dirty: boolean;
  saveError: string | null;
}) {
  return (
    <Flex
      flexShrink={0}
      align="center"
      justify="space-between"
      px="3"
      h="22px"
      borderTop="1px solid #21262d"
      bg="#0d1117"
      fontFamily="var(--grove-mono)"
      fontSize="11px"
      color="#7d8590"
    >
      <Flex gap="2" align="center">
        <Text>{language}</Text>
        {dirty && <Text color="#d29922">● modified — ⌘S to save</Text>}
        {saveError && <Text color="#f85149">{saveError}</Text>}
      </Flex>
      <Flex gap="3" align="center">
        {truncated && <Text color="#d29922">truncated</Text>}
        <Text>UTF-8</Text>
        <Text>
          Ln {cursor?.line ?? 1}, Col {cursor?.col ?? 1}
        </Text>
      </Flex>
    </Flex>
  );
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

