// CDP filtering proxy — sits in front of Chromium's --remote-debugging-port
// and presents a curated view of targets to Playwright MCP.
//
// Why this exists: Playwright MCP's `--cdp-endpoint` discovers pages via
// `GET /json`, and that list includes every web contents the Electron app
// owns — Grove's own renderer alongside the BrowserPanel. Without filtering,
// Playwright might bind to Grove's UI by accident, and @playwright/mcp has no
// `--target-filter` flag, so we filter the `/json` response on the wire.
//
// This is best-effort isolation, not a security boundary. Anything that
// bypasses `/json` (e.g. `Target.getTargets` over the browser WS) sees the
// unfiltered tree. For v1's developer-tool scope that's acceptable.

import http from 'node:http';
import net from 'node:net';

export interface CdpProxyOptions {
  realPort: number;
  getActiveTargetId: () => string | null | Promise<string | null>;
}

export interface CdpProxyHandle {
  port: number;
  close(): Promise<void>;
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  [key: string]: unknown;
}

export async function startCdpProxy(opts: CdpProxyOptions): Promise<CdpProxyHandle> {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }
      const url = req.url.split('?')[0];
      if (req.method === 'GET' && url === '/json/version') {
        const upstream = await fetchUpstream(opts.realPort, '/json/version');
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(upstream.body);
        return;
      }
      if (req.method === 'GET' && (url === '/json' || url === '/json/list')) {
        const upstream = await fetchUpstream(opts.realPort, url);
        const targetId = await opts.getActiveTargetId();
        const list = JSON.parse(upstream.body) as CdpTarget[];
        const proxyPort = (server.address() as net.AddressInfo).port;
        const filtered = targetId
          ? list
              .filter((t) => t.id === targetId)
              .map((t) => rewriteWsUrls(t, opts.realPort, proxyPort))
          : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(filtered));
        return;
      }
      // Other /json/* endpoints (`/json/protocol`, etc.) carry no target list,
      // so there's nothing to filter — forward verbatim so DevTools and CDP
      // clients beyond Playwright MCP still work.
      if (req.method === 'GET' && url.startsWith('/json/')) {
        const upstream = await fetchUpstream(opts.realPort, url);
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(upstream.body);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain' }).end(String(err));
    }
  });

  // WebSocket upgrade tunnel — opens a raw TCP socket to the real CDP port,
  // replays the upgrade request, and pipes the two sockets bidirectionally.
  // Generic enough to forward both `/devtools/page/<id>` and `/devtools/browser/<id>`.
  server.on('upgrade', (req, clientSocket, head) => {
    const upstream = net.connect(opts.realPort, '127.0.0.1', () => {
      const headers = Object.entries(req.headers)
        .flatMap(([k, v]) => (Array.isArray(v) ? v.map((vv) => [k, vv]) : v ? [[k, v]] : []))
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.on('error', teardown);
    clientSocket.on('error', teardown);
    clientSocket.on('close', teardown);
    upstream.on('close', teardown);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Bind to 127.0.0.1 (not 0.0.0.0) so the CDP surface isn't reachable from
    // other machines on the network — the host already loopback-binds, but be
    // explicit since we're a privileged debug interface.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function fetchUpstream(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

function rewriteWsUrls(t: CdpTarget, realPort: number, proxyPort: number): CdpTarget {
  const fixed: CdpTarget = { ...t };
  if (typeof fixed.webSocketDebuggerUrl === 'string') {
    fixed.webSocketDebuggerUrl = fixed.webSocketDebuggerUrl
      .replace(`://127.0.0.1:${realPort}`, `://127.0.0.1:${proxyPort}`)
      .replace(`://localhost:${realPort}`, `://localhost:${proxyPort}`);
  }
  if (typeof fixed.devtoolsFrontendUrl === 'string') {
    // DevTools frontend URLs embed the ws endpoint as a query param. Rewrite
    // there too so opening DevTools from the curated list works.
    fixed.devtoolsFrontendUrl = fixed.devtoolsFrontendUrl
      .replace(`ws=127.0.0.1:${realPort}`, `ws=127.0.0.1:${proxyPort}`)
      .replace(`ws=localhost:${realPort}`, `ws=localhost:${proxyPort}`);
  }
  return fixed;
}
