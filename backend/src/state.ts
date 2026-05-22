import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// grove-state.json is the persisted workspace/tab blob. The Electron app owns
// it (it lives in the macOS userData dir). Exposing it here lets the web build
// load the *same* workspaces over HTTP instead of starting empty from browser
// localStorage. macOS-only app, so the path is fixed; GROVE_STATE_FILE can
// override it.
const STATE_FILE =
  process.env.GROVE_STATE_FILE ||
  path.join(os.homedir(), 'Library', 'Application Support', 'Grove', 'grove-state.json');

export function registerStateRoutes(app: FastifyInstance) {
  app.get('/state', async () => {
    try {
      return { value: fs.readFileSync(STATE_FILE, 'utf8') };
    } catch {
      // No file yet — the desktop app has never persisted state.
      return { value: null };
    }
  });

  app.post<{ Body: { value?: unknown } }>('/state', async (req, reply) => {
    const value = req.body?.value;
    if (typeof value !== 'string') {
      return reply.code(400).send({ ok: false, error: 'value must be a string' });
    }
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      // tmp + rename so a crash mid-write can't corrupt the shared file; a
      // daemon-specific tmp name avoids racing Electron's own atomic write.
      const tmp = STATE_FILE + '.daemon-tmp';
      fs.writeFileSync(tmp, value, 'utf8');
      fs.renameSync(tmp, STATE_FILE);
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: String(err) });
    }
  });
}
