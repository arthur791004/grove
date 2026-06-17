import { useEffect, useRef } from 'react';
import { useStore } from './store';

// A single keyboard combo. `key` is matched case-insensitively against
// `KeyboardEvent.key`. Modifiers default to: mod (⌘/Ctrl) required, shift and
// alt forbidden — the common shape for app shortcuts. Set a modifier to `true`
// to require it or `false` to forbid it.
export interface ShortcutSpec {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

function matches(e: KeyboardEvent, spec: ShortcutSpec): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if ((spec.mod ?? true) !== mod) return false;
  if ((spec.shift ?? false) !== e.shiftKey) return false;
  if ((spec.alt ?? false) !== e.altKey) return false;
  return e.key.toLowerCase() === spec.key.toLowerCase();
}

// Panel-scoped keyboard shortcut. The handler fires only when the panel
// identified by `paneId` is the focused panel (`store.activePanelId`). This is
// the single guard that keeps panel-local shortcuts (⌘F/⌘G/⌘S in the Files
// panel) from:
//   • double-firing when the same panel kind is open in two split panes, and
//   • colliding with the global bindings in useShortcuts.ts — focusing a
//     terminal sets activePanelId=null, which disables every panel shortcut.
//
// Panes that pre-date per-pane state pass `paneId === undefined` and fall back
// to "always active" so legacy single-panel layouts keep working.
//
// The handler is held in a ref so callers don't need to memoize it; the
// window listener only re-binds when the pane id, combos, or enabled flag
// change. The handler decides whether to `preventDefault()`.
export function useScopedShortcut(
  paneId: string | undefined,
  specs: ShortcutSpec | ShortcutSpec[],
  handler: (e: KeyboardEvent) => void,
  enabled = true,
) {
  const list = Array.isArray(specs) ? specs : [specs];
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const specsRef = useRef(list);
  specsRef.current = list;
  // Stable identity for the dependency array so the effect re-binds only when
  // the actual combos change, not on every render.
  const specKey = list
    .map((s) => `${s.mod ?? true}:${s.shift ?? false}:${s.alt ?? false}:${s.key.toLowerCase()}`)
    .join('|');

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (paneId && useStore.getState().activePanelId !== paneId) return;
      if (!specsRef.current.some((spec) => matches(e, spec))) return;
      handlerRef.current(e);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneId, enabled, specKey]);
}
