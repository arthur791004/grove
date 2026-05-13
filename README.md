# Grove

A terminal with grouped vertical tabs. macOS only.

## Stack
- Electron shell
- React 18 + Chakra v3 + Vite (frontend)
- Fastify + WebSocket + node-pty (backend)
- xterm.js (terminal renderer)
- tmux (shell persistence across restarts)

## Develop
```
npm install
npm run electron:dev
```

See [FEATURES.md](./FEATURES.md) for the v1 scope.
