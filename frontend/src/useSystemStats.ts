// Subscribes the renderer to the backend's /system-stats WebSocket tick
// once at app start. Writes into a small store slice that the sidebar
// footer reads via a tight selector — broader components don't subscribe,
// so the 2-second tick doesn't fan out re-renders across the workspace.

import { useEffect } from 'react';
import { WS_BASE } from './api';
import { useStore } from './store';

export interface SystemStats {
  cpu: number; // 0..1
  memUsed: number; // bytes
  memTotal: number; // bytes
  ts: number;
}

export function useSystemStatsConnection(): void {
  const setSystemStats = useStore((s) => s.setSystemStats);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (!alive) return;
      try {
        ws = new WebSocket(`${WS_BASE}/system-stats`);
      } catch {
        retryTimer = setTimeout(connect, 5000);
        return;
      }
      ws.onmessage = (e) => {
        try {
          const parsed = JSON.parse(typeof e.data === 'string' ? e.data : '');
          if (
            parsed &&
            typeof parsed.cpu === 'number' &&
            typeof parsed.memUsed === 'number' &&
            typeof parsed.memTotal === 'number'
          ) {
            setSystemStats(parsed as SystemStats);
          }
        } catch {}
      };
      ws.onclose = () => {
        if (!alive) return;
        // Backoff briefly on disconnect so a backend restart doesn't burn
        // CPU reconnecting.
        retryTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {}
      };
    };
    connect();
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {}
    };
  }, [setSystemStats]);
}
