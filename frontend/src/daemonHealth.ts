import { create } from 'zustand';
import { API_BASE } from './api';

interface DaemonHealthState {
  pid: number | null;
  reconnectCount: number;
}

export const useDaemonHealth = create<DaemonHealthState>(() => ({
  pid: null,
  reconnectCount: 0,
}));

const POLL_INTERVAL_MS = 2000;
let started = false;

async function pollOnce(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) return;
    const body = (await res.json()) as { pid?: number };
    const pid = typeof body.pid === 'number' ? body.pid : null;
    if (pid === null) return;
    const prev = useDaemonHealth.getState().pid;
    if (prev === pid) return;
    // A change between two non-null pids means the daemon was respawned —
    // that's what drives the reconnect banner.
    const restarted = prev !== null;
    useDaemonHealth.setState((s) => ({
      pid,
      reconnectCount: restarted ? s.reconnectCount + 1 : s.reconnectCount,
    }));
  } catch {
    /* daemon down or starting up — next poll will retry */
  }
}

export function startDaemonHealthMonitor(): void {
  if (started) return;
  started = true;
  void pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}
