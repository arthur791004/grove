// Imperative API for opening the browser-pane header URL omnibox above
// the WebContentsView. Same one-shot Promise pattern as showPopupMenu:
// caller sets the request, the overlay renderer mounts HeaderOmnibox,
// the picked URL (or null) comes back through the store.

import { useStore } from './store';

type Services = NonNullable<ReturnType<typeof useStore.getState>['headerOmnibox']>['services'];
type History = NonNullable<ReturnType<typeof useStore.getState>['headerOmnibox']>['history'];

export function showHeaderOmnibox(args: {
  anchor: { x: number; y: number; width: number };
  initialValue: string;
  services: Services;
  history: History;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const id = `header-omni-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    useStore.getState().setHeaderOmnibox({ id, ...args });
    const unsub = useStore.subscribe((state) => {
      const r = state.headerOmniboxResult;
      if (!r || r.id !== id) return;
      unsub();
      useStore.getState().setHeaderOmnibox(null);
      useStore.getState().setHeaderOmniboxResult(null);
      resolve(r.pickedUrl);
    });
  });
}
