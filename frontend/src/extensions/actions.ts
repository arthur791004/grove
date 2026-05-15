import { useEffect, useRef } from 'react';

// Grove's cross-panel action bus. Any code can `dispatch('open-file', ...)`;
// any panel can `useActionHandler('open-file', fn)` to handle it. If no
// handler is registered when an action fires, the dispatch is a no-op with a
// console.warn — uninstalling the Files panel breaks "click path in terminal
// → open file" by design.
//
// Naming: built-ins use plain names (`open-file`, `open-url`). Extensions
// MUST prefix with their id (`linear.create-issue`) to avoid collisions.

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();

export function dispatch(name: string, payload?: unknown): void {
  const set = handlers.get(name);
  if (!set || set.size === 0) {
    console.warn(`[grove] action "${name}" dispatched with no handler`);
    return;
  }
  for (const fn of set) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[grove] action "${name}" handler threw`, err);
    }
  }
}

export function registerActionHandler(name: string, fn: Handler): () => void {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  set.add(fn);
  return () => {
    const s = handlers.get(name);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) handlers.delete(name);
  };
}

// React hook for panels: register a handler that re-binds when its deps
// change. Pass a stable handler via useCallback if it closes over state.
export function useActionHandler<T = unknown>(name: string, handler: (payload: T) => void): void {
  // Stash the latest handler in a ref so the subscription itself doesn't
  // re-bind on every render — only the deps change.
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    return registerActionHandler(name, (p) => ref.current(p as T));
  }, [name]);
}

// Test/inspection only.
export function _listHandlers(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of handlers) out[k] = v.size;
  return out;
}
