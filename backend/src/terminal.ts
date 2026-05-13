import type { FastifyInstance } from 'fastify';
import { subscribe, writeInput, resizeSession, destroySession } from './sessions.js';

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
  app.get<{ Params: { tabId: string } }>(
    '/pty/:tabId',
    { websocket: true },
    (socket: WSLike, req) => {
      const tabId = req.params.tabId;
      const unsubscribe = subscribe(tabId, socket);

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
}
