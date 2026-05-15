import { useSyncExternalStore } from 'react';
import type { PanelDefinition } from './types';

// Single in-memory catalog of right-panel definitions. Built-ins register at
// module load; future slices will populate it from `~/.grove/extensions/`
// manifests too. Open-state and toggling live elsewhere (in the zustand
// store) — the registry is purely "what exists, how to render it."
class PanelRegistry {
  private panels = new Map<string, PanelDefinition>();
  private listeners = new Set<() => void>();
  // Stable snapshot reference so React's useSyncExternalStore doesn't tear.
  // Rebuilt on every mutation.
  private snapshot: PanelDefinition[] = [];

  register(def: PanelDefinition): void {
    // First-registered wins (see CLAUDE.md). Built-ins register at module
    // load; if an extension tries to claim the same id, log + reject.
    if (this.panels.has(def.id)) {
      console.warn(`[grove] panel id "${def.id}" already registered; ignoring second registration`);
      return;
    }
    this.panels.set(def.id, def);
    this.rebuild();
  }

  unregister(id: string): void {
    if (!this.panels.delete(id)) return;
    this.rebuild();
  }

  get(id: string): PanelDefinition | null {
    return this.panels.get(id) ?? null;
  }

  list(): PanelDefinition[] {
    return this.snapshot;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private rebuild(): void {
    // Built-ins first (preserves Files / Diff / Browser ordering), then
    // extension panels in registration order.
    const builtins: PanelDefinition[] = [];
    const extensions: PanelDefinition[] = [];
    for (const p of this.panels.values()) {
      (p.source === 'builtin' ? builtins : extensions).push(p);
    }
    this.snapshot = [...builtins, ...extensions];
    for (const fn of this.listeners) fn();
  }
}

export const panelRegistry = new PanelRegistry();

// React hook for components that want to re-render when panels change.
// Doesn't trigger renders today (built-ins register once at startup) but is
// the right shape once dynamic extension loading lands.
export function usePanels(): PanelDefinition[] {
  return useSyncExternalStore(
    panelRegistry.subscribe,
    () => panelRegistry.list(),
    () => panelRegistry.list(),
  );
}
