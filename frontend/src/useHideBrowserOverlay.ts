// Coordinates parking the BrowserPanel's WebContentsView offscreen whenever
// any DOM overlay (modal, drag preview) is open. The native view can't be
// z-ordered against the React DOM — its only states are "attached at
// these bounds" or "detached from the window" — so each overlay that
// would otherwise be hidden behind the browser flips a shared counter;
// the view is removed from the window while the counter is > 0 and
// re-added when it returns to zero.
//
// For dropdowns, prefer the native Menu.popup() path (window.grove.showMenu)
// instead of a DOM dropdown that needs this hook — the OS draws the menu
// above every Chromium layer, so there's no z-fight to resolve.

import { useEffect } from 'react';

let openCount = 0;

function setHidden(hidden: boolean) {
  void window.grove?.browser?.setOverlayHidden?.(hidden);
}

function adjust(delta: number) {
  const prev = openCount;
  openCount = Math.max(0, openCount + delta);
  if (prev === 0 && openCount > 0) setHidden(true);
  else if (prev > 0 && openCount === 0) setHidden(false);
}

export function useHideBrowserOverlay(isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return;
    adjust(+1);
    return () => adjust(-1);
  }, [isOpen]);
}
