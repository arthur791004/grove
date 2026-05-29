// Coordinates parking the BrowserPanel's WebContentsView offscreen whenever
// any DOM overlay (dropdown menu, modal, dialog) is open. The native view
// can't be z-ordered against the React DOM — its only states are "visible at
// these bounds" or "parked at 0x0" — so each overlay that would otherwise
// be hidden behind the browser flips a shared counter; the view is hidden
// while the counter is > 0 and restored when it returns to zero.
//
// While the view is parked we also render a still-frame snapshot of each
// browser pane (captured via webContents.capturePage just before parking) in
// the DOM at the same bounds. This keeps the leaf from going blank during
// the overlay's lifetime, so dropdowns/modals appear to float over a frozen
// browser instead of an empty rectangle.

import { useEffect, useSyncExternalStore } from 'react';

export interface BrowserSnapshot {
  paneId: string;
  dataUrl: string;
  bounds: { x: number; y: number; width: number; height: number };
}

let openCount = 0;
let snapshots: BrowserSnapshot[] = [];
const subs = new Set<() => void>();
// Bumped on every hide cycle so a stale capture (resolving after the user
// has already closed the overlay) doesn't paint a snapshot over a now-live
// view.
let cycle = 0;

function notify() {
  for (const fn of subs) fn();
}

function setSnapshots(next: BrowserSnapshot[]) {
  snapshots = next;
  notify();
}

function setHidden(hidden: boolean) {
  void window.grove?.browser?.setOverlayHidden?.(hidden);
}

async function captureThenPark(myCycle: number) {
  try {
    // Capture BEFORE hiding — once the view is parked at 0x0 the page would
    // capture as an empty image. Order: capture → render snapshot → park.
    const shots = (await window.grove?.browser?.captureAll?.()) ?? [];
    if (myCycle !== cycle) return; // overlay closed while we were capturing
    setSnapshots(shots);
    setHidden(true);
  } catch {
    if (myCycle !== cycle) return;
    setHidden(true); // capture failed; still park so the menu is usable
  }
}

function adjust(delta: number) {
  const prev = openCount;
  openCount = Math.max(0, openCount + delta);
  if (prev === 0 && openCount > 0) {
    cycle += 1;
    void captureThenPark(cycle);
  } else if (prev > 0 && openCount === 0) {
    cycle += 1;
    setHidden(false);
    setSnapshots([]);
  }
}

export function useHideBrowserOverlay(isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return;
    adjust(+1);
    return () => adjust(-1);
  }, [isOpen]);
}

function subscribe(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

function getSnapshot(): BrowserSnapshot[] {
  return snapshots;
}

export function useBrowserSnapshots(): BrowserSnapshot[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
