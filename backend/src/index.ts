import Fastify from 'fastify';
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
import { sessionCwd } from './sessions.js';

const PORT = Number(process.env.GROVE_BACKEND_PORT ?? 4317);

async function main() {
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

  app.get<{ Params: { tabId: string } }>('/session/:tabId/cwd', async (req) => {
    return { cwd: sessionCwd(req.params.tabId) };
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/env/home', async () => ({ home: os.homedir() }));

  await app.listen({ port: PORT, host: '127.0.0.1' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
