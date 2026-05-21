import { API_BASE, sendSessionInput } from './api';
import { useStore } from './store';

// One-time `--append-system-prompt` flag seeding a Claude tab opened in a
// freshly-forked workspace with a summary of the parent's recent activity.
// Returns '' for non-fork tabs or once the fork has already been seeded.
async function forkContextFlag(tabId: string): Promise<string> {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.id === tabId);
  const group = tab && st.groups.find((g) => g.id === tab.groupId);
  if (!group?.forkedFromId || group.forkContextConsumed) return '';
  const parent = st.groups.find((g) => g.id === group.forkedFromId);
  if (!parent) return '';
  // Only the first Claude tab in a fork inherits parent context.
  st.markForkContextConsumed(group.id);
  // Prefer the parent's most-recent Claude tab for command history; fall back
  // to any parent tab (the JSONL transcript itself is keyed by cwd, not tab).
  const parentTab =
    [...st.tabs].reverse().find((t) => t.groupId === parent.id && t.kind === 'claude') ??
    [...st.tabs].reverse().find((t) => t.groupId === parent.id);
  const qs = new URLSearchParams({ cwd: parent.cwd });
  if (parentTab) qs.set('tabId', parentTab.id);
  const res = await fetch(`${API_BASE}/fork-context?${qs.toString()}`);
  if (!res.ok) return '';
  const data = (await res.json()) as { path?: string | null };
  return data?.path ? `--append-system-prompt "$(cat '${data.path}')"` : '';
}

// Builds and sends the `claude` invocation for a tab. `sessionId` starts a new
// session with a Grove-owned id (so a later tab can offer to join it);
// `resume` continues an existing session's transcript instead.
//
// When the workspace has a live browser panel target we splice in
// `--mcp-config <path>` so Claude Code can drive it via CDP.
export async function launchClaude(
  tabId: string,
  opts: { sessionId: string } | { resume: string },
): Promise<void> {
  const configPath = await window.grove?.mcp?.writePlaywrightConfig(tabId).catch(() => null);
  const flags: string[] = [];
  if (configPath) flags.push(`--mcp-config ${configPath}`);

  let sessionId: string;
  if ('resume' in opts) {
    sessionId = opts.resume;
    flags.push(`--resume ${opts.resume}`);
  } else {
    sessionId = opts.sessionId;
    flags.push(`--session-id ${opts.sessionId}`);
    // Parent context seeds a brand-new session only — never a resumed one,
    // which already carries its own conversation history.
    const ctxFlag = await forkContextFlag(tabId).catch(() => '');
    if (ctxFlag) flags.push(ctxFlag);
  }

  // Record which Claude session this tab is bound to so a later Claude tab in
  // the same workspace can offer to join it.
  useStore.getState().setTabClaudeSession(tabId, sessionId);
  await sendSessionInput(tabId, `claude ${flags.join(' ')}\r`);
}

// Boots `claude` into a freshly-attached pty for a tab created in Claude mode.
// If the workspace already runs a Claude session, defers to the New/Join
// modal (via `sessionChoice`) instead of launching immediately.
export async function bootstrapClaude(tabId: string): Promise<void> {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const sibling = st.tabs.find(
    (t) =>
      t.id !== tabId && t.groupId === tab.groupId && t.kind === 'claude' && !!t.claudeSessionId,
  );
  if (sibling?.claudeSessionId) {
    const group = st.groups.find((g) => g.id === tab.groupId);
    st.setSessionChoice({
      tabId,
      joinSessionId: sibling.claudeSessionId,
      workspaceName: group?.name ?? 'this workspace',
    });
    return;
  }
  await launchClaude(tabId, { sessionId: crypto.randomUUID() });
}
