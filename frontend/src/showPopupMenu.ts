// Imperative API for opening the styled dropdown rendered by
// <PopupMenu>. Split out from popupMenu.tsx so the component file has
// only React component exports — mixing a helper function with the
// component breaks Vite's React Fast Refresh, which silently invalidates
// hot updates and leaves the running overlay window on stale code.

import { useStore } from './store';

export interface PopupMenuItem {
  id: string;
  label: string;
  // Optional second line shown under the label in muted text. Use for short
  // explanatory hints (e.g. "Adds a workspace rooted at ~").
  hint?: string;
  enabled?: boolean;
}

export function showPopupMenu(
  items: PopupMenuItem[],
  anchor: { x: number; y: number },
): Promise<string | null> {
  return new Promise((resolve) => {
    const id = `popup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    useStore.getState().setPopupMenu({ id, items, anchor });
    const unsub = useStore.subscribe((state) => {
      const r = state.popupMenuResult;
      if (!r || r.id !== id) return;
      unsub();
      useStore.getState().setPopupMenu(null);
      useStore.getState().setPopupMenuResult(null);
      resolve(r.pickedId);
    });
  });
}
