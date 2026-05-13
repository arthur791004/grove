import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import { subscribe, writeInput, resizeSession, destroySession } from './sessions.js';

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

interface WSLike {
  send(data: string): void;
  close(): void;
  on(event: 'message', cb: (raw: Buffer) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

type ClientMsg =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export function registerTerminalRoutes(app: FastifyInstance) {
  app.get<{ Params: { tabId: string }; Querystring: { cwd?: string } }>(
    '/pty/:tabId',
    { websocket: true },
    (socket: WSLike, req) => {
      const tabId = req.params.tabId;
      const cwd = req.query.cwd ? expandHome(req.query.cwd) : undefined;
      let unsubscribe: () => void;
      try {
        unsubscribe = subscribe(tabId, socket, cwd);
      } catch (err) {
        console.error('[grove] subscribe failed for', tabId, err);
        try { socket.close(); } catch {}
        return;
      }

      socket.on('message', (raw: Buffer) => {
        let msg: ClientMsg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'input') writeInput(tabId, msg.data);
        else if (msg.type === 'resize') resizeSession(tabId, msg.cols, msg.rows);
      });

      socket.on('close', () => { unsubscribe(); });
      socket.on('error', (err) => { console.error('[grove] ws error', tabId, err); });
    },
  );

  app.delete<{ Params: { tabId: string } }>('/session/:tabId', async (req) => {
    destroySession(req.params.tabId);
    return { ok: true };
  });

  app.post<{ Params: { tabId: string }; Body: { data: string } }>(
    '/session/:tabId/input',
    async (req) => {
      writeInput(req.params.tabId, req.body?.data ?? '');
      return { ok: true };
    },
  );
}
