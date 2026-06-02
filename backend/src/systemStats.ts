// Periodic system stats broadcast for the sidebar footer gauges.
// Pushes a small JSON tick over a WebSocket so the frontend doesn't have
// to poll. Single shared sampling loop — no per-client work.

import type { FastifyInstance } from 'fastify';
import os from 'node:os';

interface CpuSnapshot {
  total: number;
  idle: number;
}

interface SystemStatsTick {
  cpu: number; // 0..1 — fraction of total CPU time busy across all cores
  memUsed: number; // bytes
  memTotal: number; // bytes
  ts: number;
}

function sampleCpu(): CpuSnapshot {
  const cpus = os.cpus();
  let total = 0;
  let idle = 0;
  for (const c of cpus) {
    const t = c.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}

function computeCpu(prev: CpuSnapshot, next: CpuSnapshot): number {
  const totalDelta = next.total - prev.total;
  const idleDelta = next.idle - prev.idle;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - idleDelta / totalDelta));
}

// Minimal shape needed from the @fastify/websocket socket — same pattern
// used elsewhere in the backend to avoid pulling in the ws types.
interface WSLike {
  readyState: number;
  OPEN: number;
  send(data: string): void;
  close(): void;
  on(event: 'close' | 'error', cb: () => void): void;
}

export function registerSystemStatsRoutes(app: FastifyInstance): void {
  const clients = new Set<WSLike>();
  let prevSnap: CpuSnapshot = sampleCpu();
  let lastTick: SystemStatsTick | null = null;
  const INTERVAL_MS = 2000;

  const tick = () => {
    const next = sampleCpu();
    const cpu = computeCpu(prevSnap, next);
    prevSnap = next;
    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();
    const payload: SystemStatsTick = { cpu, memUsed, memTotal, ts: Date.now() };
    lastTick = payload;
    const json = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(json);
        } catch {}
      }
    }
  };

  // Keep the sampling loop running only while there are subscribers — no
  // background work in the empty-app case.
  let timer: NodeJS.Timeout | null = null;
  const startTimer = () => {
    if (timer) return;
    prevSnap = sampleCpu(); // reset baseline so the first tick isn't a giant delta
    timer = setInterval(tick, INTERVAL_MS);
  };
  const stopTimer = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    lastTick = null;
  };

  app.get('/system-stats', { websocket: true }, (socket: WSLike) => {
    clients.add(socket);
    startTimer();
    // Send the last known tick immediately so the gauge isn't empty for
    // up to INTERVAL_MS while we wait for the next sample.
    if (lastTick) socket.send(JSON.stringify(lastTick));
    socket.on('close', () => {
      clients.delete(socket);
      if (clients.size === 0) stopTimer();
    });
    socket.on('error', () => {
      clients.delete(socket);
      if (clients.size === 0) stopTimer();
    });
  });
}
