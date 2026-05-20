// Dev runs the backend on a separate port (4318) so it never collides with an
// installed/packaged Grove on the default 4317. `import.meta.env.DEV` is true
// under `vite` and false in `vite build`, so packaged bundles keep 4317.
const BACKEND_PORT = import.meta.env.DEV ? 4318 : 4317;

export const API_BASE = `http://127.0.0.1:${BACKEND_PORT}`;
export const WS_BASE = `ws://127.0.0.1:${BACKEND_PORT}`;

// Best-effort write into a tab's pty stdin. Used for sending keystrokes
// (Ctrl-C, Enter), agent replies, and auto-typed bootstrap commands. Errors
// are intentionally swallowed — the caller is event-driven and a missing pty
// just means the tab is already gone.
export function sendSessionInput(tabId: string, data: string): Promise<void> {
  return fetch(`${API_BASE}/session/${tabId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
    .then(() => undefined)
    .catch(() => undefined);
}
