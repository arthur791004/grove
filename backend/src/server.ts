import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import os from 'node:os';
import { registerTerminalRoutes } from './terminal.js';
import { registerContextRoutes } from './context.js';
import { registerCompletionRoutes } from './completions.js';
import { registerCompleteRoutes } from './complete.js';
import { registerDiffRoutes } from './diff.js';
import { registerFileRoutes } from './files.js';
import { registerServiceRoutes } from './services.js';
import { registerForkContextRoutes } from './forkContext.js';
import { sessionCwd } from './sessions.js';

export interface StartServerOptions {
  port: number;
  host?: string;
}

export async function startServer(opts: StartServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);
  registerTerminalRoutes(app);
  registerContextRoutes(app);
  registerCompletionRoutes(app);
  registerCompleteRoutes(app);
  registerDiffRoutes(app);
  registerFileRoutes(app);
  registerServiceRoutes(app);
  registerForkContextRoutes(app);

  app.get<{ Params: { tabId: string } }>('/session/:tabId/cwd', async (req) => {
    return { cwd: sessionCwd(req.params.tabId) };
  });

  app.get('/health', async () => ({ ok: true, pid: process.pid }));
  app.get('/env/home', async () => ({ home: os.homedir() }));

  await app.listen({ port: opts.port, host: opts.host ?? '127.0.0.1' });
  return app;
}
