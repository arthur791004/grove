// Dev runs the backend on a separate port (4318) so it never collides with an
// installed/packaged Grove on the default 4317. `import.meta.env.DEV` is true
// under `vite` and false in `vite build`, so packaged bundles keep 4317.
const BACKEND_PORT = import.meta.env.DEV ? 4318 : 4317;

export const API_BASE = `http://127.0.0.1:${BACKEND_PORT}`;
export const WS_BASE = `ws://127.0.0.1:${BACKEND_PORT}`;
