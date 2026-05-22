import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import os from 'node:os';
import { registerTerminalRoutes } from './terminal.js';
import { registerContextRoutes } from './context.js';
import { registerCompletionRoutes } from './completions.js';
import { registerCompleteRoutes } from './complete.js';
import { registerDiffRoutes } from './diff.js';
import { registerFileRoutes } from './files.js';
import { registerServiceRoutes } from './services.js';
import { registerForkContextRoutes } from './forkContext.js';
import { registerStateRoutes } from './state.js';
import { sessionCwd } from './sessions.js';
import { isLoopback, isTailscale } from './remoteConfig.js';

export interface StartServerOptions {
  port: number;
  host?: string;
  // Remote mode: when both are set, the built renderer at `staticRoot` is
  // served over HTTP and every non-loopback request is gated by `remoteToken`.
  // Omitting either keeps the server local-only with no static serving.
  staticRoot?: string;
  remoteToken?: string;
}

// Cookie set on the served index.html so a paired phone carries the token on
// every later request — including the PTY WebSocket upgrade — without it
// living in the URL bar.
const TOKEN_COOKIE = 'grove_token';

function tokenFromRequest(req: FastifyRequest): string | null {
  const q = (req.query as { token?: unknown } | undefined)?.token;
  if (typeof q === 'string' && q) return q;
  const header = req.headers['x-grove-token'];
  if (typeof header === 'string' && header) return header;
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq !== -1 && part.slice(0, eq).trim() === TOKEN_COOKIE) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
  }
  return null;
}

export async function startServer(opts: StartServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const remote =
    opts.staticRoot && opts.remoteToken
      ? { staticRoot: opts.staticRoot, token: opts.remoteToken }
      : null;

  // Remote mode binds broadly (0.0.0.0) so the daemon is reachable over
  // Tailscale, but this hook is the real gate: loopback (the Electron app) is
  // always allowed and never needs a token; tailnet peers (100.64.0.0/10) must
  // present the access token; everything else — LAN, public — is rejected
  // before any handler runs, so no shell is ever spawned for them. When remote
  // mode is off the server is loopback-bound (or explicitly opened with
  // GROVE_HOST in dev), so the hook deliberately does nothing.
  app.addHook('onRequest', async (req, reply) => {
    if (!remote) return;
    const ip = req.socket.remoteAddress ?? '';
    if (isLoopback(ip)) return;
    if (!isTailscale(ip)) {
      return reply
        .code(403)
        .type('text/plain')
        .send('Grove: remote access is restricted to your Tailscale network.\n');
    }
    if (tokenFromRequest(req) !== remote.token) {
      return reply
        .code(401)
        .type('text/plain')
        .send('Grove: missing or invalid access token — open the URL from Settings.\n');
    }
  });

  registerTerminalRoutes(app);
  registerContextRoutes(app);
  registerCompletionRoutes(app);
  registerCompleteRoutes(app);
  registerDiffRoutes(app);
  registerFileRoutes(app);
  registerServiceRoutes(app);
  registerForkContextRoutes(app);
  registerStateRoutes(app);

  app.get<{ Params: { tabId: string } }>('/session/:tabId/cwd', async (req) => {
    return { cwd: sessionCwd(req.params.tabId) };
  });

  app.get('/health', async () => ({ ok: true, pid: process.pid }));
  app.get('/env/home', async () => ({ home: os.homedir() }));

  if (remote) {
    await app.register(fastifyStatic, {
      root: remote.staticRoot,
      prefix: '/',
      // The explicit `/` route below owns index.html so it can set the token
      // cookie; let @fastify/static handle only the hashed asset files.
      index: false,
    });
    app.get('/', async (_req, reply) => {
      reply.header(
        'set-cookie',
        `${TOKEN_COOKIE}=${encodeURIComponent(remote.token)}; Path=/; SameSite=Lax; HttpOnly`,
      );
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port: opts.port, host: opts.host ?? '127.0.0.1' });
  return app;
}
