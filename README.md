# Grove

A terminal app with grouped vertical tabs, Warp-style command blocks, an
embedded browser, and a built-in file/diff explorer. macOS only.

<img width="1511" height="886" alt="image" src="https://github.com/user-attachments/assets/f067b7ee-0e80-4f06-ac32-390aaff4e58c" />

## Highlights

- **Grouped vertical tabs** — drag tabs between named workspaces; each
  workspace pins its own cwd.
- **Warp-style blocks** — every command is its own block with cwd, node, git
  branch, exit code, and duration chips. Per-block menu for rerun / copy /
  delete. Persists across restarts (`~/.grove/blocks/{tabId}.json`).
- **Right-side panels** (mutually exclusive, ~40% of content width):
  - **Browser** — discovers running dev servers via `lsof`, embeds them in
    an iframe at a 1280-min desktop viewport (scale-to-fit on narrow
    panels) or a 390 mobile frame. Recents are scoped per workspace. Strips
    `X-Frame-Options` / `frame-ancestors` for localhost so dev servers
    embed. Chrome-style "site can't be reached" page on connection
    failure.
  - **Files** — virtualized file browser with search (`git ls-files` when
    in a repo, otherwise a guarded walk), file preview, ⌘-click from
    terminal output to open a path.
  - **Diff** — live `git diff` view of the current cwd; mirrors what you'd
    see in PR review.
- **Shell integration** — custom zsh init via `ZDOTDIR` emits OSC 133 +
  custom `grove-pre` / `grove-post` / `grove-env` markers, so blocks have
  proper bounds, exit codes, and live env (node version, git branch,
  virtualenv, AWS profile…) without polling.
- **Streaming context** — backend pushes ctx changes over the WS
  (debounced) instead of clients polling.
- **Clickable output** — paths (`src/App.tsx:10:5`), OSC 8 hyperlinks, and
  http(s) URLs in command output are all clickable. URLs open in the
  embedded browser panel; paths open in the file browser.

## Stack

- Electron shell (custom titlebar, IPC for folder picker / open external /
  frame nav forwarding)
- React 18 + Chakra v3 + Vite + Zustand (persisted to localStorage)
- Fastify + WebSocket + node-pty (backend on `127.0.0.1:4317`)
- xterm.js for raw-mode TUI overlay (vim, htop, ssh, claude…)
- `lsof` for service discovery
- Disk-persisted block history (`~/.grove/blocks/{tabId}.json`)

## Develop

```
npm install
npm run dev:all
```

`dev:all` builds the Electron main process, then runs backend + Vite +
Electron in parallel. A `kill-ports` step nukes any stale listeners on
4317 and 5173 first so restarts don't conflict.

See [FEATURES.md](./FEATURES.md) for the v1 scope.
