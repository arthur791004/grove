# Grove — Features

macOS only. Single window. Dark theme only. The granular tracking doc behind
[README.md](README.md) — README has the story, this has the checkboxes.

## Done

### Terminal & layout

- [x] Vertical sidebar with grouped tabs (named, drag between groups via dnd-kit)
- [x] Sidebar toggle button + ⌘\ shortcut
- [x] Draggable window region (titleBarStyle: hiddenInset)
- [x] Per-tab PTY (node-pty) via Fastify WebSocket
- [x] Tmux-backed shells (auto-detected; falls back to plain shell if missing)
- [x] Bottom-anchored streaming input + block-based output (custom UI, not xterm)
- [x] xterm.js raw-mode overlay for TUI apps (vim, htop, claude, ssh) — alt-screen
      sequence detection auto-switches between blocks and raw modes
- [x] Snapshot raw-mode TUI output into the block on exit (compresses CUF runs back
      into spaces so `Welcome back Arthur!` reads as words, not `WelcomebackArthur!`)
- [x] OSC 133 shell-integration markers + custom `grove-pre` / `grove-post` /
      `grove-env` markers (zsh init via `ZDOTDIR`) — cleanly delimit each command's
      block and capture exit code + duration without polling

### Blocks UI

- [x] Each command + output renders as a block: header chips (node, cwd, branch, duration)
      then bolded command then ANSI-colored output
- [x] Full ANSI SGR support: bold/italic/underline/inverse/strike, 8/16/256/RGB
      fg and bg (38;5/38;2/48;5/48;2)
- [x] Full-width blocks with top border separators
- [x] Red left-border on failed exit (transparent otherwise)
- [x] Per-block hover menu: rerun, copy, delete
- [x] Bottom-anchored: short outputs hug the chip strip, longer outputs scroll
- [x] `clear` and other CSI reset sequences wipe block list

### Clickable output

- [x] OSC 8 hyperlinks rendered as clickable spans
- [x] Path-like tokens (`src/App.tsx:10:5`, `./foo/bar`, `~/x`) auto-linkified, open
      in Files panel via `/file/resolve`
- [x] `http(s)://...` URLs in output open in the Browser panel (not external)
- [x] ⌘-click semantics so accidental drags don't navigate

### Right-side panels

- [x] Three mutually-exclusive panels, ~40% of content width, toggled per tab:
      Browser / Files / Diff
- [x] **Files** — virtualized browser, `git ls-files` aware in repos with a
      guarded walk fallback, search, file preview
- [x] **Diff** — live `git diff` of the current cwd, the view you'd see in PR review
- [x] **Browser** — iframe-based, discovers dev servers via `lsof`, strips
      `X-Frame-Options` / `frame-ancestors` for localhost so dev servers embed,
      1280-min desktop viewport (scale-to-fit) or 390 mobile frame, per-workspace
      recents, Chrome-style error page on connection failure

### Input ergonomics

- [x] Inline ghost-text autocomplete (gray suggestion after cursor + Tab keycap chip)
- [x] Suggestion sources, in priority: in-session history → server contextual → server defaults
- [x] Contextual completions via backend `/complete`: `cd` dirs, `ls/cat/...` files,
      `git checkout/switch/merge/rebase/branch` branches, `npm/yarn/pnpm run` package.json scripts
- [x] Server-side completions endpoint reads `~/.zsh_history` + bundled defaults list
- [x] Shell-history prefix navigation (↑/↓ filters by what's already typed)
- [x] Custom 2px caret in Warp accent (`#83C2D7`), tracked to cursor position
- [x] Command history per tab (↑/↓), Ctrl+C clears input or sends SIGINT if empty
- [x] Footer click-to-focus the prompt; auto-focus on tab switch

### Tab management

- [x] CRUD (new/close/rename/reorder), drag between groups
- [x] Tab colors (7-color palette)
- [x] Keyboard shortcuts: ⌘T, ⌘W, ⌘1..9, ⌘⇧[/], ⌘P, ⌘\
- [x] Fuzzy tab search (⌘P, Fuse.js)
- [x] Per-tab context strip above input: ⬢ node / 📁 cwd / ⎇ branch / ± diff
- [x] PTY resize on tab/panel reflow (raw-mode TUIs see correct cols/rows)

### Persistence & infra

- [x] Block history persisted to `~/.grove/blocks/{tabId}.json`, survives restarts
- [x] Origin-independent UI state at `userData/grove-state.json` (tabs, panels,
      recents) — survives the dev (http://) → packaged (grove://) origin change
- [x] Window size/position restored (electron-window-state)
- [x] Streaming context: backend pushes ctx changes over WS (debounced) instead
      of clients polling — chips update live on `cd`, branch switch, node change
- [x] Packaged as Grove.app (electron-builder), backend spawned as child node
      process from `app.asar.unpacked/backend/dist`
- [x] Custom `grove://` protocol serves the renderer via `net.fetch` so React.lazy
      code-split chunks load with a real origin
- [x] WS auto-reconnect with backoff so the startup race doesn't show errors
- [x] ANSI palette tuned for #010409 background (GitHub-dark inspired)

## Roadmap

Mirrors the README — granular subtasks where useful.

### ✅ Real embedded browser (WebContentsView)

- [x] Replace iframe with Electron `WebContentsView`
- [x] WebAuthn / security-key support for 2FA on staging+prod
- [x] Real `setZoomFactor` viewport scaling (replaces CSS transform hack)
- [x] Persistent cookies via Electron's default session
- [ ] Chrome extensions via `electron-chrome-extensions` (1Password, etc.)
- [ ] Per-workspace cookie partitions

### ✅ Workspace forking via git worktrees

- [x] Right-click workspace → **Fork workspace** (and `+ → Fork workspace…`)
- [x] Generated animal-hash branch names (`grove/<animal>-<4hex>`)
- [x] Forks slot directly under their source in the sidebar
- [x] Close-workspace confirm dialog warns about uncommitted / unpushed changes
- [x] Worktree dir + grove/\* branch both deleted on close (always — confirm gates dirty cases)
- [x] Workspace branch chip (sidebar) — updates from the existing WS ctx stream, no polling
- [x] Per-tab chip only renders when its branch differs from the workspace's
- [x] Settings → Clean up Grove branches: detects orphan branches + worktree dirs from earlier builds, bulk-deletes
- [ ] Per-worktree port range
- [ ] Per-worktree block history (already keyed by tabId; generalize to worktree path)
- [ ] Cleanup prompt to prune worktrees whose branch is merged on remote

### ✅ Settings panel

- [x] Titlebar gear opens a Chakra Dialog
- [x] Appearance: mono font family + size, live-applied to xterm and the rest of the UI
- [x] Clean up Grove branches section (see above)
- [x] Persisted across restart via the existing grove-state.json

### 🚧 Claude Code as the default shell

- [ ] Tab launches into Claude Code agentic session by default
- [ ] Preserve repo context + shell aliases
- [ ] Drop to raw zsh with `⌘\`
- [ ] Session persistence per worktree under `~/.grove/sessions/<branch>.jsonl`
- [ ] Decide: default vs. opt-in mode

### 🚧 Ask Claude on every block

- [ ] Right-click → Ask Claude
- [ ] Ships command + output + exit code + cwd + branch + env in one payload
- [ ] First-class block-context schema (reused by block sharing below)

### 🚧 Block sharing

- [ ] One-click "share" produces a paste-ready snippet
- [ ] Bug-report-quality dump variant (full env, exit, full output)

## Smaller wins still open

Older Tier-2/3 items worth keeping on the list.

- [ ] **Block search (⌘F)** — fuzzy-match `cmd + output` across blocks in the
      active tab; `<mark>` highlights
- [ ] **Multi-line input** — `<textarea>`; Enter at end submits, Enter mid-line
      inserts newline; smart paste-as-multi-line
- [ ] **Block bookmarking** — star a block; pinned tray in sidebar
- [ ] **Image protocol** (iTerm2 OSC 1337 `File=`) — `imgcat foo.png` renders
      inline `<img>`
- [ ] **Running-command indicator in tab** — command name + spinner on the tab
      while a block is in-flight (drive from `block-start` / `block-end`)
- [ ] **Write Grove-run commands to `~/.zsh_history`** — extended-history format
      `: <ts>:<dur>;<cmd>` so other terminals see them
- [ ] **Notifications when long commands finish** — `durationMs > 10s` + window
      unfocused at `block-end` → `new Notification(...)`
- [ ] **Splits / panes within a tab** — recursive binary tree, per-pane PTY
      (`react-resizable-panels` already a dep)
- [ ] **Tab templates / workflows** — saved cmd snippets with `{{param}}` substitution

### Explicitly skipped

Cloud sessions, Warp Drive, SSH first-class UI, GPU renderer, broadcast input,
vim mode in the input field, multi-window, settings UI, light theme, theme
picker, font picker, cross-platform (macOS only by design for now).

## Implementation notes (for reference)

- **Blocks** — OSC 133 markers from `precmd`/`preexec` hooks parsed by the
  backend, plus a custom OSC 1337 marker that carries the command text and
  cwd in base64 (see `backend/src/shellInit.ts`).
- **TUI handling** — backend watches the PTY stream for alt-screen
  `\x1b[?1049h`/`\x1b[?47h`, switches into raw terminal grid mode, then back
  on the corresponding `l` exit. xterm's SerializeAddon captures the final
  frame for the block snapshot.
- **Autocomplete** — small hand-coded subset of Fig-style contextual
  completions plus `~/.zsh_history` as a fallback source.
- **Themes** — single GitHub-dark-inspired palette via CSS classes
  (`ansi-*-fg`/`-bg`); the SGR renderer emits classes for basic colors and
  inline `style.color`/`background` for 256/RGB values.
- **Custom protocol** — `grove://app/<path>` resolves to `frontend/dist/<path>`
  inside the asar bundle via `protocol.handle` + `net.fetch`. Loading from
  `file://` would give the renderer a null origin and break dynamic
  `import()` of code-split chunks.
