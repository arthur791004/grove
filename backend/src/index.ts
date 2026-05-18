import { setupBackendLogging } from './logger.js';
import { startServer } from './server.js';

setupBackendLogging();

const PORT = Number(process.env.GROVE_BACKEND_PORT ?? 4317);

// Exit if the Electron main process disappears (e.g., crash, SIGKILL). Without
// this the backend lingers as an orphan holding port 4317 + every spawned pty.
// The daemon entry point (`daemon.ts`) deliberately omits this — a daemon
// outlives Electron by design.
const parentPid = process.ppid;
if (parentPid && parentPid !== 1) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 2000).unref();
}

startServer({ port: PORT }).catch((err) => {
  console.error(err);
  process.exit(1);
});
