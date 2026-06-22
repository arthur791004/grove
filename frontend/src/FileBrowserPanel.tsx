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
  type AssistantRequest,
} from './codemirror/CodeMirrorEditor';
import { InlineAssistantBar, type AssistantStatus } from './InlineAssistantBar';
import { FileTabBar } from './FileTabBar';
import { detectCmLanguage } from './codemirror/language-detect';
import { useScopedShortcut } from './useScopedShortcut';
import { diffLines } from 'diff';

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

interface GrepHit {
  line: number;
  col: number;
  preview: string;
}
interface GrepFile {
  path: string;
  abs: string;
  hits: GrepHit[];
}
interface GrepResponse {
  cwdReady: boolean;
  root: string;
  files: GrepFile[];
  rgAvailable: boolean;
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

interface FileCacheEntry {
  // null while still fetching. Errored loads set `error` and leave `content`
  // null; truncated / unreadable files use truncated/content=null too.
  content: string | null;
  truncated: boolean;
  size: number;
  error: string | null;
  loading: boolean;
  // User's unsaved buffer. When present, this is what we load into the editor
  // instead of `content`. Saving clears it back to undefined.
  draft?: string;
  dirty: boolean;
  saveError: string | null;
}

// Strip the markdown code fence Claude sometimes ignores instructions and
// wraps responses in. Tolerates ```ts, ```typescript, etc.
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n?```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
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
  // Multi-file tabs. `openFiles` is the ordered list of open tabs; `activeFile`
  // is the one currently in the editor. Per-file state (content / dirty /
  // load + save status) lives in `fileCache`, keyed by absolute path.
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileCache, setFileCache] = useState<Record<string, FileCacheEntry>>({});
  // Cursor + scroll snapshots per file. Refs (not state) because they update
  // on every keystroke / scroll and we don't want to re-render the panel for
  // those.
  const fileSnapshotRef = useRef<Record<string, { cursorOffset: number; scrollTop: number }>>({});
  // Tracks which file the editor's view currently holds — used to know which
  // file's snapshot to capture before swapping in the next one.
  const editorLoadedFileRef = useRef<string | null>(null);
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
  // Active file's derived state (read from the cache). Useful as local
  // shortcuts in the render + handlers below.
  const activeEntry = activeFile ? fileCache[activeFile] : null;
  const fileContent: FileContentResponse | null = activeEntry
    ? {
        content: activeEntry.content,
        truncated: activeEntry.truncated,
        size: activeEntry.size,
        error: activeEntry.error,
      }
    : null;
  const fileLoading = !!activeEntry?.loading;
  const dirty = !!activeEntry?.dirty;
  const saveError = activeEntry?.saveError ?? null;

  // Inline AI assistant state. `request` captures the selection snapshot at
  // ⌘↵ time — we hold onto the original text + offsets so Reject can restore
  // and Accept knows where to splice the response.
  const [assistant, setAssistant] = useState<{
    request: AssistantRequest;
    prompt: string;
    status: AssistantStatus;
    streamingText: string;
    response: string;
    errorMessage: string;
  } | null>(null);
  const assistantAbortRef = useRef<AbortController | null>(null);
  const [query, setQuery] = useState('');
  // The persistent header search input; ⌘F focuses it.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [grepResults, setGrepResults] = useState<GrepFile[] | null>(null);
  const [grepAvailable, setGrepAvailable] = useState(true);
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
    setOpenFiles([]);
    setActiveFile(null);
    setFileCache({});
    fileSnapshotRef.current = {};
    editorLoadedFileRef.current = null;
    setNarrowView('list');
    setDir(null);
    setDirError(null);
    setQuery('');
    setSearchResults(null);
    setGrepResults(null);
    dirCache.current.clear();
  }, [activeTabId, ctx?.shortCwd]);

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
      setGrepResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    // Two parallel queries: fast path-rank for filename matches, then grep
    // through file contents. The grep is debounced a bit longer so we don't
    // spin up ripgrep on every keystroke.
    const id = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ tabId: activeTabId, q });
        const [pathRes, grepRes] = await Promise.all([
          fetch(`${API_BASE}/files/search?${params.toString()}`).then((r) =>
            r.json(),
          ) as Promise<SearchResponse>,
          fetch(`${API_BASE}/files/grep?${params.toString()}`).then((r) =>
            r.json(),
          ) as Promise<GrepResponse>,
        ]);
        if (cancelled) return;
        setSearchResults(pathRes.results ?? []);
        setGrepResults(grepRes.files ?? []);
        setGrepAvailable(grepRes.rgAvailable !== false);
      } catch (err) {
        if (!cancelled) console.error('[grove] file search failed', err);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [activeTabId, query]);

  // Fetch any newly-opened file whose cache slot is empty. Each fetch lives
  // independently — switching tabs while one is in flight just leaves it
  // running and the result lands in the cache regardless of which file is
  // active when it arrives.
  useEffect(() => {
    if (!activeTabId) return;
    const toFetch = openFiles.filter((p) => !fileCache[p]);
    if (toFetch.length === 0) return;
    // Seed loader entries up-front so the editor swap effect sees `loading:
    // true` and skips the load until content arrives.
    setFileCache((prev) => {
      const next = { ...prev };
      for (const p of toFetch) {
        if (!next[p]) {
          next[p] = {
            content: null,
            truncated: false,
            size: 0,
            error: null,
            loading: true,
            dirty: false,
            saveError: null,
          };
        }
      }
      return next;
    });
    let cancelled = false;
    for (const p of toFetch) {
      (async () => {
        try {
          const params = new URLSearchParams({ tabId: activeTabId, path: p });
          const res = await fetch(`${API_BASE}/file/content?${params.toString()}`);
          const json: FileContentResponse = await res.json();
          if (cancelled) return;
          setFileCache((prev) => ({
            ...prev,
            [p]: {
              ...(prev[p] ?? {
                draft: undefined,
                dirty: false,
                saveError: null,
              }),
              content: json.content,
              truncated: json.truncated,
              size: json.size,
              error: json.error,
              loading: false,
              dirty: false,
              saveError: null,
            },
          }));
        } catch (err) {
          if (cancelled) return;
          setFileCache((prev) => ({
            ...prev,
            [p]: {
              ...(prev[p] ?? { dirty: false, saveError: null }),
              content: null,
              truncated: false,
              size: 0,
              error: String((err as Error).message || err),
              loading: false,
              dirty: false,
              saveError: null,
            },
          }));
        }
      })();
    }
    return () => {
      cancelled = true;
    };
    // fileCache is intentionally excluded — the toFetch filter handles
    // dedupe, and including it would loop forever as each fetch mutates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, openFiles]);

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
  // when listOpen is true, otherwise just the preview takes over. An active
  // search query always forces the list/results pane open (and, when narrow,
  // takes over the single visible pane) so header-search results are reachable
  // even with the file list collapsed.
  const hasQuery = query.trim().length > 0;
  const showList = hasQuery || (isNarrow ? narrowView === 'list' : listOpen);
  const showPreview = isNarrow ? !hasQuery && narrowView === 'preview' : true;

  function openOrActivateFile(p: string) {
    setOpenFiles((prev) => (prev.includes(p) ? prev : [...prev, p]));
    setActiveFile(p);
    if (isNarrow) setNarrowView('preview');
  }

  function openFileAt(p: string, line: number, col: number) {
    editorTargetRef.current = { path: p, line, col };
    openOrActivateFile(p);
  }

  function closeFile(p: string) {
    const entry = fileCache[p];
    if (entry?.dirty && !window.confirm('Discard unsaved changes?')) return;
    setOpenFiles((prev) => {
      const next = prev.filter((x) => x !== p);
      // If the closed tab was active, fall back to the previous tab — VS
      // Code's behaviour. Picking the neighbour by index, not history.
      if (activeFile === p) {
        if (next.length === 0) {
          setActiveFile(null);
          if (isNarrow) setNarrowView('list');
        } else {
          const closedIdx = prev.indexOf(p);
          const fallback = next[Math.max(0, closedIdx - 1)] ?? next[0];
          setActiveFile(fallback);
        }
      }
      return next;
    });
    setFileCache((prev) => {
      if (!prev[p]) return prev;
      const { [p]: _drop, ...rest } = prev;
      void _drop;
      return rest;
    });
    delete fileSnapshotRef.current[p];
  }
  function backToList() {
    setNarrowView('list');
  }

  // Honor cmd+click requests from terminal blocks. For directories we just
  // navigate. For files we navigate to the parent AND stash a `pendingSelect`
  // — the dir-loaded effect below will open the tab once the parent listing
  // shows up.
  useEffect(() => {
    if (!fileRequest) return;
    const p = fileRequest.path;
    if (fileRequest.kind === 'dir') {
      setPath(p);
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
        openOrActivateFile(p);
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
    openOrActivateFile(pendingSelect);
    setPendingSelect(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir?.cwd, pendingSelect]);

  // Push the loaded file into CodeMirror. The target (line/col + Claude edit
  // range) is read from editorTargetRef and consumed exactly once — a second
  // re-render of the same file (e.g. the same path clicked twice in the tree)
  // shouldn't re-jump the cursor or re-show the highlight. Before swapping,
  // capture the outgoing tab's draft / cursor / scroll so a later re-activate
  // restores the user where they left off.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    // Snapshot the outgoing tab (if it's still open). Skip the snapshot when
    // the outgoing tab was removed from openFiles (closeFile already cleaned
    // its state up).
    const outgoing = editorLoadedFileRef.current;
    if (outgoing && outgoing !== activeFile && openFiles.includes(outgoing)) {
      const wasDirty = dirtyOfFileRef.current[outgoing] === true;
      const draft = wasDirty ? editor.getValue() : undefined;
      fileSnapshotRef.current[outgoing] = {
        cursorOffset: editor.getCursorOffset(),
        scrollTop: editor.getScrollTop(),
      };
      if (wasDirty) {
        setFileCache((prev) =>
          prev[outgoing] ? { ...prev, [outgoing]: { ...prev[outgoing], draft } } : prev,
        );
      }
    }

    if (!activeFile) {
      editor.clear();
      editorLoadedFileRef.current = null;
      setCursorPos(null);
      return;
    }
    // Don't re-open the same file just because something in the cache mutated
    // (e.g. the dirty flag flipped from a keystroke). The editor already has
    // the live content; reloading here would wipe the user's edits.
    if (editorLoadedFileRef.current === activeFile) return;
    const entry = fileCache[activeFile];
    if (!entry || entry.loading) return; // still fetching
    if (entry.error || entry.content === null) {
      editor.clear();
      editorLoadedFileRef.current = null;
      setCursorPos(null);
      return;
    }
    const target =
      editorTargetRef.current && editorTargetRef.current.path === activeFile
        ? editorTargetRef.current
        : null;
    editorTargetRef.current = null;
    const snap = fileSnapshotRef.current[activeFile];
    const loadContent = entry.draft ?? entry.content;
    editor.openFile({
      path: activeFile,
      content: loadContent,
      line: target?.line,
      col: target?.col,
      claudeEditRange: target?.claudeEditRange,
      cursorOffset: target ? undefined : snap?.cursorOffset,
      scrollTop: target ? undefined : snap?.scrollTop,
      dirty: entry.draft !== undefined,
    });
    editorLoadedFileRef.current = activeFile;
    setCursorPos({ line: target?.line ?? 1, col: target?.col ?? 1 });
    // openFiles is included so we can detect when the outgoing tab has been
    // closed (and skip its snapshot).
  }, [activeFile, fileCache, openFiles]);

  // Live snapshot of each file's dirty bit, kept in a ref so the swap effect
  // above (which doesn't subscribe to fileCache mutations between snapshots)
  // can read the latest value without re-binding.
  const dirtyOfFileRef = useRef<Record<string, boolean>>({});
  for (const [p, e] of Object.entries(fileCache)) dirtyOfFileRef.current[p] = e.dirty;

  // ⌘F — focus the header search input (scoped to the focused Files panel so
  // it never shadows the browser find in an unfocused pane).
  useScopedShortcut(paneId, { key: 'f' }, (e) => {
    e.preventDefault();
    const input = searchInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  });

  // ⌘G — go to line in the active file.
  useScopedShortcut(paneId, { key: 'g' }, (e) => {
    if (!activeFile) return;
    e.preventDefault();
    editorRef.current?.promptGotoLine();
  });

  // ⌘S — save the active file to disk.
  const save = async () => {
    if (!activeFile || !activeTabId) return;
    const editor = editorRef.current;
    if (!editor) return;
    const cur = fileCache[activeFile];
    if (cur?.truncated) {
      setFileCache((prev) =>
        prev[activeFile]
          ? {
              ...prev,
              [activeFile]: {
                ...prev[activeFile],
                saveError: 'Cannot save: file was truncated on load',
              },
            }
          : prev,
      );
      return;
    }
    const content = editor.getValue();
    try {
      const res = await fetch(`${API_BASE}/file/content`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tabId: activeTabId, path: activeFile, content }),
      });
      const json = await res.json();
      if (!json.ok) {
        setFileCache((prev) =>
          prev[activeFile]
            ? {
                ...prev,
                [activeFile]: { ...prev[activeFile], saveError: json.error || 'Save failed' },
              }
            : prev,
        );
        return;
      }
      editor.markClean();
      setFileCache((prev) =>
        prev[activeFile]
          ? {
              ...prev,
              [activeFile]: {
                ...prev[activeFile],
                content,
                size: json.size ?? prev[activeFile].size,
                draft: undefined,
                dirty: false,
                saveError: null,
              },
            }
          : prev,
      );
    } catch (err) {
      const msg = String((err as Error).message || err);
      setFileCache((prev) =>
        prev[activeFile]
          ? { ...prev, [activeFile]: { ...prev[activeFile], saveError: msg } }
          : prev,
      );
    }
  };
  useScopedShortcut(paneId, { key: 's' }, (e) => {
    if (!activeFile) return;
    e.preventDefault();
    void save();
  });

  // Editor dirty bit → mark the active file dirty in the cache.
  function onEditorDirtyChange(d: boolean) {
    if (!activeFile) return;
    setFileCache((prev) =>
      prev[activeFile] && prev[activeFile].dirty !== d
        ? { ...prev, [activeFile]: { ...prev[activeFile], dirty: d } }
        : prev,
    );
  }

  // Editor → assistant: ⌘↵ in CodeMirror calls this. We replace any existing
  // session (D7: one active prompt bar at a time).
  function onAssistantRequest(req: AssistantRequest) {
    if (!activeFile) return;
    assistantAbortRef.current?.abort();
    assistantAbortRef.current = null;
    editorRef.current?.clearAiOverlay();
    setAssistant({
      request: req,
      prompt: '',
      status: 'idle',
      streamingText: '',
      response: '',
      errorMessage: '',
    });
  }

  function dismissAssistant() {
    assistantAbortRef.current?.abort();
    assistantAbortRef.current = null;
    editorRef.current?.clearAiOverlay();
    setAssistant(null);
  }

  async function submitAssistant() {
    const cur = assistant;
    if (!cur || !activeFile || !activeTabId) return;
    if (!cur.prompt.trim()) return;
    const ctrl = new AbortController();
    assistantAbortRef.current = ctrl;
    setAssistant({
      ...cur,
      status: 'streaming',
      streamingText: '',
      response: '',
      errorMessage: '',
    });

    try {
      const lang = detectCmLanguage(activeFile).label;
      const res = await fetch(`${API_BASE}/assistant/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          tabId: activeTabId,
          prompt: cur.prompt,
          context: {
            filePath: activeFile,
            language: lang,
            selectedText: cur.request.selectedText,
            surroundingLines: cur.request.surroundingLines,
            selectionRange: cur.request.selectionRange,
          },
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const evt = JSON.parse(line.slice(5).trim());
              if (evt.type === 'delta') {
                accumulated += evt.content as string;
                setAssistant((s) => (s ? { ...s, streamingText: accumulated } : s));
              } else if (evt.type === 'done') {
                finalizeAssistantResponse(accumulated);
                return;
              } else if (evt.type === 'error') {
                setAssistant((s) =>
                  s ? { ...s, status: 'error', errorMessage: String(evt.message) } : s,
                );
                return;
              }
            } catch {
              // Skip malformed frames silently.
            }
          }
        }
      }
      // Stream closed without a `done` event — treat what we have as final.
      if (accumulated) finalizeAssistantResponse(accumulated);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setAssistant((s) =>
        s ? { ...s, status: 'error', errorMessage: String((err as Error).message || err) } : s,
      );
    } finally {
      if (assistantAbortRef.current === ctrl) assistantAbortRef.current = null;
    }
  }

  // Compute the diff between the original selection and Claude's response,
  // paint the overlay over the editor, and flip the bar into result mode.
  function finalizeAssistantResponse(rawResponse: string) {
    const response = stripCodeFences(rawResponse).trimEnd();
    setAssistant((s) => (s ? { ...s, status: 'result', response } : s));
    const editor = editorRef.current;
    const cur = assistantRef.current;
    if (!editor || !cur) return;
    // Splice the response into a doc copy to figure out which lines will be
    // "added" relative to the existing doc, then paint those.
    const original = cur.request.selectedText;
    const parts = diffLines(original, response);
    if (parts.every((p) => !p.added && !p.removed)) {
      // No-op response: just dismiss.
      editor.clearAiOverlay();
      return;
    }
    // Mark the original selection's line range as "removed" (strikethrough
    // overlay). The added lines are shown in a side overlay via the prompt
    // bar's preview — slice-4 v1 keeps the editor doc unchanged until accept.
    editor.showAiOverlay({
      addedLines: [],
      removedFrom: cur.request.selectionRange.fromLine,
      removedTo: cur.request.selectionRange.toLine,
    });
  }

  function acceptAssistant() {
    const cur = assistant;
    if (!cur || cur.status !== 'result') return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.applyAiChange({
      from: cur.request.selectionOffsets.from,
      to: cur.request.selectionOffsets.to,
      insert: cur.response,
    });
    // Trigger the same ⌘S save path. We synthesise the event so we don't have
    // to refactor the save closure out of its useEffect.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }));
    setAssistant(null);
  }

  function tryAgainAssistant() {
    const cur = assistant;
    if (!cur) return;
    editorRef.current?.clearAiOverlay();
    setAssistant({ ...cur, status: 'idle', streamingText: '', response: '', errorMessage: '' });
  }

  // Held in a ref so finalizeAssistantResponse can read the live request
  // without re-binding on every change.
  const assistantRef = useRef(assistant);
  assistantRef.current = assistant;

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
        {/* Left zone: list toggle + current path. flex=1 mirrors the right
            gutter so the search bar stays centred between equal gaps. */}
        <Flex align="center" gap="1.5" flex="1" minW="0">
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
            flexShrink={1}
            maxW="42%"
            title={activeFile || dir?.cwd}
          >
            {activeFile
              ? `${relativeToBase(activeFile, dir?.cwd ?? '')}${fileContent?.truncated ? ' · truncated' : ''}`
              : (dir?.shortCwd ?? '…')}
          </Text>
        </Flex>
        {/* Centred search — wider than the side zones, but the equal flex=1
            gutters on either side keep it horizontally centred with matching
            left/right gaps. */}
        <Box flex="2" minW="0" maxW="460px" display="flex">
          <HeaderSearch
            inputRef={searchInputRef}
            value={query}
            onChange={setQuery}
            searching={searching}
            onClear={() => {
              setQuery('');
              setSearchResults(null);
              setGrepResults(null);
            }}
          />
        </Box>
        {/* Right gutter balances the left zone so the search stays centred. */}
        <Box flex="1" minW="0" />
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
            <Box flex="1" minH="0" overflow="hidden">
              {query.trim() ? (
                <SearchResults
                  results={searchResults}
                  grepResults={grepResults}
                  grepAvailable={grepAvailable}
                  searching={searching}
                  query={query.trim()}
                  selectedFile={activeFile}
                  onPick={openOrActivateFile}
                  onPickHit={openFileAt}
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
                              r.kind === 'entry' && !r.entry.isDir && activeFile === r.entry.path
                            }
                            onClick={
                              r.entry.isDir
                                ? () => setPath(r.entry.path)
                                : () => openOrActivateFile(r.entry.path)
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
            <FileTabBar
              tabs={openFiles.map((p) => ({ path: p, dirty: !!fileCache[p]?.dirty }))}
              activePath={activeFile}
              onActivate={(p) => setActiveFile(p)}
              onClose={closeFile}
            />
            <Box flex="1" minH="0" minW="0" position="relative">
              <PreviewSurface
                file={activeFile}
                content={fileContent}
                loading={fileLoading}
                editorRef={editorRef}
                onCursorChange={setCursorPos}
                onLanguageChange={setLanguageLabel}
                onDirtyChange={onEditorDirtyChange}
                onAssistantRequest={onAssistantRequest}
              />
              {assistant && activeFile && (
                <InlineAssistantBar
                  anchorTop={assistant.request.anchorTop}
                  context={{
                    filePath: activeFile,
                    language: languageLabel,
                    selectedText: assistant.request.selectedText,
                    surroundingLines: assistant.request.surroundingLines,
                    fullContent: assistant.request.fullContent,
                    selectionRange: assistant.request.selectionRange,
                  }}
                  status={assistant.status}
                  prompt={assistant.prompt}
                  onPromptChange={(next) => setAssistant((s) => (s ? { ...s, prompt: next } : s))}
                  onSubmit={submitAssistant}
                  onDismiss={dismissAssistant}
                  streamingText={assistant.streamingText}
                  errorMessage={assistant.errorMessage}
                  onAccept={acceptAssistant}
                  onReject={dismissAssistant}
                  onTryAgain={tryAgainAssistant}
                />
              )}
            </Box>
            {activeFile && (
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

// Persistent search bar that lives in the centre of the panel header. ⌘F (see
// the scoped shortcut in FileBrowserPanel) focuses it; Escape clears and blurs.
function HeaderSearch({
  inputRef,
  value,
  onChange,
  searching,
  onClear,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  value: string;
  onChange: (v: string) => void;
  searching: boolean;
  onClear: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Flex
      align="center"
      flex="1"
      minW="0"
      h="24px"
      px="1.5"
      gap="1.5"
      borderRadius="5px"
      bg="#010409"
      border="1px solid"
      borderColor={focused ? '#1f6feb' : '#30363d'}
      transition="border-color 120ms ease"
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
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            if (value) onClear();
            inputRef.current?.blur();
          }
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
          onClick={onClear}
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
  grepResults,
  grepAvailable,
  searching,
  query,
  selectedFile,
  onPick,
  onPickHit,
}: {
  results: SearchHit[] | null;
  grepResults: GrepFile[] | null;
  grepAvailable: boolean;
  searching: boolean;
  query: string;
  selectedFile: string | null;
  onPick: (abs: string) => void;
  onPickHit: (abs: string, line: number, col: number) => void;
}) {
  if (results === null && grepResults === null && searching) {
    return (
      <Flex h="100%" align="center" justify="center">
        <SquareLoader />
      </Flex>
    );
  }
  const pathCount = results?.length ?? 0;
  const grepCount = grepResults?.reduce((n, f) => n + f.hits.length, 0) ?? 0;
  if (pathCount === 0 && grepCount === 0 && !searching) {
    return (
      <Text px="3" py="2" fontSize="12px" color="#7d8590">
        No matches.
      </Text>
    );
  }
  return (
    <Box h="100%" overflowY="auto" overflowX="hidden">
      {pathCount > 0 && <SectionHeader label="Files" count={pathCount} />}
      {results?.map((r) => {
        const slash = r.path.lastIndexOf('/');
        const name = slash >= 0 ? r.path.slice(slash + 1) : r.path;
        const dir = slash >= 0 ? r.path.slice(0, slash) : '';
        return (
          <Flex
            key={`f:${r.abs}`}
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
                icon={iconNameForFile(name)}
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
      })}
      {grepCount > 0 && (
        <SectionHeader
          label="Matches"
          count={grepCount}
          subtitle={`in ${grepResults!.length} file${grepResults!.length === 1 ? '' : 's'}`}
        />
      )}
      {grepResults?.map((file) => (
        <Box key={`g:${file.abs}`} pb="1">
          <Flex
            align="center"
            gap="1.5"
            px="2"
            h="22px"
            color="#c9d1d9"
            cursor="pointer"
            _hover={{ bg: '#161b22' }}
            onClick={() => onPick(file.abs)}
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
                icon={iconNameForFile(file.path.split('/').pop() || file.path)}
                width="14"
                height="14"
                style={{ display: 'block' }}
              />
            </Box>
            <Text fontFamily="var(--grove-mono)" fontSize="11px" truncate title={file.path}>
              {file.path}
            </Text>
          </Flex>
          {file.hits.map((hit, i) => (
            <Flex
              key={i}
              align="center"
              gap="2"
              pl="6"
              pr="2"
              h="20px"
              fontFamily="var(--grove-mono)"
              fontSize="11px"
              cursor="pointer"
              color="#7d8590"
              _hover={{ bg: '#161b22', color: '#c9d1d9' }}
              onClick={() => onPickHit(file.abs, hit.line, hit.col)}
              title={hit.preview}
            >
              <Text color="#6e7681" flexShrink={0}>
                {hit.line}
              </Text>
              <HighlightedPreview text={hit.preview} query={query} />
            </Flex>
          ))}
        </Box>
      ))}
      {!grepAvailable && grepCount === 0 && (
        <Text px="3" py="2" fontSize="11px" color="#7d8590">
          Install ripgrep (`rg`) to search file contents.
        </Text>
      )}
    </Box>
  );
}

function SectionHeader({
  label,
  count,
  subtitle,
}: {
  label: string;
  count: number;
  subtitle?: string;
}) {
  return (
    <Flex
      align="center"
      gap="2"
      px="2"
      h="22px"
      fontSize="10px"
      color="#7d8590"
      fontFamily="var(--grove-mono)"
      textTransform="uppercase"
      letterSpacing="0.05em"
      bg="#0d1117"
      borderTop="1px solid #21262d"
      borderBottom="1px solid #21262d"
    >
      <Text>{label}</Text>
      <Text color="#6e7681">{count}</Text>
      {subtitle && <Text color="#6e7681">· {subtitle}</Text>}
    </Flex>
  );
}

function HighlightedPreview({ text, query }: { text: string; query: string }) {
  if (!query) {
    return (
      <Text truncate minW="0" flex="1">
        {text}
      </Text>
    );
  }
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) {
      parts.push({ text: text.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ text: text.slice(i, idx), hit: false });
    parts.push({ text: text.slice(idx, idx + needle.length), hit: true });
    i = idx + needle.length;
  }
  return (
    <Text truncate minW="0" flex="1" as="span">
      {parts.map((p, idx) =>
        p.hit ? (
          <Text as="span" key={idx} color="#f0f6fc" bg="rgba(255,210,80,0.18)">
            {p.text}
          </Text>
        ) : (
          <Text as="span" key={idx}>
            {p.text}
          </Text>
        ),
      )}
    </Text>
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
  onAssistantRequest,
}: {
  file: string | null;
  content: FileContentResponse | null;
  loading: boolean;
  editorRef: React.RefObject<CodeMirrorHandle>;
  onCursorChange: (p: CursorPosition) => void;
  onLanguageChange: (label: string) => void;
  onDirtyChange: (d: boolean) => void;
  onAssistantRequest: (req: AssistantRequest) => void;
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
          onAssistantRequest={onAssistantRequest}
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
