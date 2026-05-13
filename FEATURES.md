# Grove — Features

macOS only. Single window. Dark theme only.

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
- [x] OSC 133 shell-integration markers (custom zsh init via ZDOTDIR) — used to
      cleanly delimit each command's block and capture exit code + duration

### Blocks UI
- [x] Each command + output renders as a block: header chips (node, cwd, branch, duration)
      then bolded command then ANSI-colored output
- [x] Full-width blocks with top border separators
- [x] Red left-border on failed exit (transparent otherwise)
- [x] Hover surfaces filter + ⋮ icons (placeholders for actions)
- [x] Bottom-anchored: short outputs hug the chip strip, longer outputs scroll
- [x] `clear` and other CSI reset sequences wipe block list

### Input ergonomics
- [x] Inline ghost-text autocomplete (gray suggestion after cursor + Tab keycap chip)
- [x] Suggestion sources, in priority: in-session history → server contextual → server defaults
- [x] Contextual completions via backend `/complete`: `cd` dirs, `ls/cat/...` files,
      `git checkout/switch/merge/rebase/branch` branches, `npm/yarn/pnpm run` package.json scripts
- [x] Server-side completions endpoint reads `~/.zsh_history` + bundled defaults list
- [x] Custom 2px caret in Warp accent (`#83C2D7`), tracked to cursor position
- [x] Command history per tab (↑/↓), Ctrl+C clears input or sends SIGINT if empty

### Tab management
- [x] CRUD (new/close/rename/reorder), drag between groups
- [x] Tab colors (7-color palette)
- [x] Keyboard shortcuts: ⌘T, ⌘W, ⌘1..9, ⌘⇧[/], ⌘P, ⌘\
- [x] Fuzzy tab search (⌘P, Fuse.js)
- [x] Per-tab context strip above input: ⬢ node / 📁 cwd / ⎇ branch / ± diff

### Persistence & infra
- [x] Tab/group structure persisted (Zustand persist → localStorage)
- [x] Window size/position restored (electron-window-state)
- [x] WS auto-reconnect with backoff so the startup race doesn't show errors
- [x] Backend CORS for dev mode, request logging off
- [x] ANSI palette tuned for #010409 background (GitHub-dark inspired)

## TODO — Warp parity roadmap

In order of impact-per-effort. Pick from this list to plan next phase.

### Tier 1 (small effort, high signal)
- [ ] **Block hover toolbar** — wire `copy command` / `copy output` / `copy both` / `re-run` /
      `bookmark` to the existing hover icons. `navigator.clipboard.writeText`; re-run sets the
      input state.
- [ ] **Click-block → restore command** — clicking a past block's command line pushes that
      text into the input ready to edit.
- [ ] **Auto tab title from cwd** — when user hasn't manually renamed, set `tab.title` to
      `basename(cwd)`. Already polling cwd in `useTabContext`.
- [ ] **Running-command indicator in tab** — show command name + spinner on the tab while
      a block is in-flight. Drive from `block-start` / `block-end` WS events.
- [ ] **Write Grove-run commands to `~/.zsh_history`** — so other terminals see them. Append
      with the extended-history format `: <ts>:<dur>;<cmd>`.
- [ ] **Linkified URLs in output** — `http(s)://...` regex pass over block output, render
      as clickable anchors. macOS open via `shell.openExternal` from electron preload.
- [ ] **Notifications when long commands finish** — if `durationMs > 10s` and window not
      focused at `block-end`, fire `new Notification('grove', { body: 'cmd done in 23s' })`.

### Tier 2 (medium effort)
- [ ] **Block search (⌘F)** — overlay input that fuzzy-matches `cmd + output` across blocks
      in the active tab; `<mark>` highlights.
- [ ] **Multi-line input** — replace `<input>` with `<textarea>`; Enter at end submits,
      Enter mid-line inserts newline; smart paste-as-multi-line.
- [ ] **Block bookmarking** — star a block; pinned tray in sidebar.
- [ ] **Image protocol (iTerm2 OSC 1337 `File=`)** — `imgcat foo.png` renders inline `<img>`.
- [ ] **Fuzzy history search (⌘R)** — overlay listing matched recent commands.

### Tier 3 (large effort)
- [ ] **Splits / panes within a tab** — recursive binary tree, per-pane PTY, focus tracking.
      `react-resizable-panels` already a dep.
- [ ] **Tab templates (TOML)** — predefined layouts like Warp's tab-configs (`~/.warp/tab_configs/*.toml`).
- [ ] **Workflows / parameterized commands** — saved cmd snippets with `{{param}}` substitution.
- [ ] **Cross-platform support** — Windows/Linux. tmux unavailable on Windows; need fallback.

### Explicitly skipped
AI / Agent Mode, cloud sessions, Warp Drive, SSH first-class UI, GPU renderer,
broadcast input, vim mode in the input field, multi-window, settings UI,
light theme, theme picker, font picker.

## Warp implementation notes (for reference)

- **Blocks** — OSC 133 markers from `precmd`/`preexec` hooks, parsed by the terminal.
  Grove uses the same protocol + a custom OSC 1337 marker that carries the command text and
  cwd in base64 form (see `backend/src/shellInit.ts`).
- **TUI handling** — Warp watches the PTY stream for alt-screen `\x1b[?1049h`/`\x1b[?47h`,
  switches into raw terminal grid mode, then back on the corresponding `l` exit.
- **Autocomplete** — Warp absorbed Fig: ~500+ TypeScript spec files describing each CLI
  tool, plus dynamic generators that run shell commands to fetch live data (`git branch`,
  `ls`, `package.json` scripts, `docker ps`, `kubectl get pods`). Grove uses a tiny
  hand-coded subset of that approach.
- **Tab title sync** — Warp tracks shell title escape (OSC 0 / OSC 2) plus cwd, and falls
  back to the running command name during a block.
- **Themes** — Warp ships YAML theme files mapping all 16 ANSI colors + bg/fg/accent.
  Grove ships a single GitHub-dark-inspired palette via CSS classes (`ansi-*-fg`/`-bg`)
  that ansi-to-react applies.
