import { execSync, spawnSync } from 'node:child_process';

let cachedAvailable: boolean | null = null;

export function isTmuxAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  try {
    execSync('command -v tmux', { stdio: 'ignore' });
    cachedAvailable = true;
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

export function sessionName(tabId: string): string {
  return `grove-${tabId}`;
}

export function sessionExists(tabId: string): boolean {
  const r = spawnSync('tmux', ['has-session', '-t', sessionName(tabId)], { stdio: 'ignore' });
  return r.status === 0;
}

export function ensureSession(tabId: string, cwd: string, envOverrides: Record<string, string> = {}): void {
  if (sessionExists(tabId)) return;
  const args = ['new-session', '-d', '-s', sessionName(tabId), '-c', cwd, '-x', '200', '-y', '50'];
  for (const [k, v] of Object.entries(envOverrides)) {
    args.push('-e', `${k}=${v}`);
  }
  spawnSync('tmux', args);
}

export function killSession(tabId: string): void {
  spawnSync('tmux', ['kill-session', '-t', sessionName(tabId)], { stdio: 'ignore' });
}

export function attachArgs(tabId: string): string[] {
  return ['attach-session', '-t', sessionName(tabId)];
}
