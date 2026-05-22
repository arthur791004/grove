// Dev runs the backend on a separate port (4318) so it never collides with an
// installed/packaged Grove on the default 4317. `import.meta.env.DEV` is true
// under `vite` and false in `vite build`, so packaged bundles keep 4317.
const BACKEND_PORT = import.meta.env.DEV ? 4318 : 4317;

// The packaged Electron renderer loads from the grove:// protocol and always
// talks to a local backend. Anything else — the Vite dev server, or the
// production bundle the daemon serves over HTTP in remote mode — is a real web
// page that may be loaded from another device (a phone over Tailscale). There
// we must talk to whatever host served the page, not a hardcoded 127.0.0.1,
// which on a phone would mean the phone itself.
const BACKEND_HOST =
  window.location.protocol === 'grove:' ? '127.0.0.1' : window.location.hostname;

export const API_BASE = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
export const WS_BASE = `ws://${BACKEND_HOST}:${BACKEND_PORT}`;

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
