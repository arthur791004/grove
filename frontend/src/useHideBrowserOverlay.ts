// Coordinates parking the BrowserPanel's WebContentsView offscreen whenever
// any DOM overlay (dropdown menu, modal, dialog) is open. The native view
// can't be z-ordered against the React DOM — its only states are "visible at
// these bounds" or "parked at 0x0" — so each overlay that would otherwise
// be hidden behind the browser flips a shared counter; the view is hidden
// while the counter is > 0 and restored when it returns to zero.

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
