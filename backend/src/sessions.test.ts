import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  getOrCreateSession,
  destroySession,
  writeInput,
  sessionCount,
  SessionLimitError,
  MAX_SESSIONS,
} from './sessions.js';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

// A clean destroy (shell with no children to trap signals) should release the
// pty almost immediately via SIGHUP. This is the happy-path baseline.
test('destroySession releases pty for an idle shell', async () => {
  const tabId = `test-clean-${Date.now()}`;
  const s = getOrCreateSession(tabId, os.tmpdir());
  const pid = s.pty.pid;
  assert.ok(pidAlive(pid), 'pty pid should be alive after spawn');

  destroySession(tabId);

  const dead = await waitFor(() => !pidAlive(pid), 1500);
  assert.ok(dead, `shell pid ${pid} still alive after destroySession`);

  // Re-creating with the same tabId must return a brand-new pty, not the
  // dead one — otherwise we'd be handing out stale entries from the map.
  const s2 = getOrCreateSession(tabId, os.tmpdir());
  assert.notEqual(s2.pty.pid, pid);
  destroySession(tabId);
});

// Hitting MAX_SESSIONS must throw rather than calling pty.spawn — without
// this cap the OS forkpty(3) limit eventually fails with the cryptic
// "Could not create a new process and open a pseudo-tty" message.
test('getOrCreateSession enforces MAX_SESSIONS cap', async () => {
  const ids: string[] = [];
  try {
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      const id = `test-cap-${Date.now()}-${i}`;
      getOrCreateSession(id, os.tmpdir());
      ids.push(id);
    }
    assert.equal(sessionCount(), MAX_SESSIONS);
    assert.throws(
      () => getOrCreateSession(`test-cap-over-${Date.now()}`, os.tmpdir()),
      (err: unknown) => err instanceof SessionLimitError && err.limit === MAX_SESSIONS,
    );
    // Reusing an existing tabId must still work even at the cap.
    const reuse = getOrCreateSession(ids[0], os.tmpdir());
    assert.ok(reuse);
  } finally {
    for (const id of ids) destroySession(id);
  }
});

// The regression we care about: a foreground child that ignores SIGHUP must
// not keep the pty master fd allocated forever. destroySession should escalate
// to SIGKILL and reap the shell within ~1s.
test('destroySession escalates to SIGKILL when child traps SIGHUP', async () => {
  const tabId = `test-hup-trap-${Date.now()}`;
  const s = getOrCreateSession(tabId, os.tmpdir());
  const pid = s.pty.pid;

  // Run inside the shell: ignore HUP, then sleep. The shell process itself
  // installs the trap, so a plain SIGHUP to the pty will be swallowed.
  writeInput(tabId, "trap '' HUP; sleep 60\n");

  // Give zsh time to install the trap and start sleep. If we destroy too
  // early, the test would pass trivially via the SIGHUP path.
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(pidAlive(pid), 'shell should still be alive while sleeping');

  const t0 = Date.now();
  destroySession(tabId);

  const dead = await waitFor(() => !pidAlive(pid), 2000);
  const elapsed = Date.now() - t0;
  assert.ok(dead, `shell pid ${pid} still alive ${elapsed}ms after destroySession`);
});
