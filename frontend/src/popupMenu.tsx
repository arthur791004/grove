// Custom styled dropdown menu rendered in whichever renderer hosts the
// modal layer (the overlay BrowserWindow in Electron, the main renderer
// in web). Callers anywhere — including a renderer that *doesn't* host
// the menu UI — request one via `showPopupMenu()` and await the picked
// id; the request and the result both travel through the cross-renderer
// state bridge that already syncs the zustand store.
//
// We use this instead of Electron's native Menu.popup() because the OS
// menu styling clashes with Grove's dark theme. Modals are already
// floating above the WebContentsView in the overlay window, so the
// dropdown can ride the same infrastructure with no z-fight.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Text } from '@chakra-ui/react';
import { useStore } from './store';

// Gap between the menu edge and the viewport edge when we shift/flip
// away from the anchor. Needs to clear BOTH the box itself AND the drop
// shadow's blur (30 px on this menu) — at 32 the shadow still reaches
// the viewport edge and the menu reads as "glued to the boundary." 48
// leaves the shadow's blur tail to fall off cleanly inside the viewport.
const VIEWPORT_PAD = 48;

// Exit animation duration. Kept short so the menu doesn't feel sticky on
// dismiss — long enough to read as a fade rather than a flicker.
const EXIT_MS = 120;

export function PopupMenu() {
  const popup = useStore((s) => s.popupMenu);
  const setResult = useStore((s) => s.setPopupMenuResult);

  // Track whether we should be visually open or closing. The actual
  // store-level close (setResult → setPopupMenu(null)) is deferred until
  // the exit animation finishes; this state drives the in-flight phase.
  const [phase, setPhase] = useState<'enter' | 'open' | 'exit'>('enter');
  // Reset to 'enter' whenever a fresh popup arrives (different id) so the
  // entrance animation plays. Use a microtask to advance to 'open' on the
  // next frame — that way the transition runs from the entry styles to
  // the rest state.
  useLayoutEffect(() => {
    if (!popup) return;
    setPhase('enter');
    const id = requestAnimationFrame(() => setPhase('open'));
    return () => cancelAnimationFrame(id);
  }, [popup?.id]);

  // Single close pathway used by backdrop click, Esc, and item click —
  // flips to 'exit', waits for the fade-out, then commits the result.
  const closeWith = useCallback(
    (pickedId: string | null) => {
      if (!popup) return;
      setPhase('exit');
      const popupId = popup.id;
      setTimeout(() => {
        setResult({ id: popupId, pickedId });
      }, EXIT_MS);
    },
    [popup, setResult],
  );

  // Esc dismisses (matches the rest of the app's modal contract).
  useEffect(() => {
    if (!popup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeWith(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [popup, closeWith]);

  // Measure-then-adjust placement: render the menu at the requested
  // anchor, measure it, and shift/flip if it would overflow the
  // viewport. First render uses the raw anchor (off-screen for menus
  // near the edge); the layout effect re-positions in the same frame
  // before paint, so the user shouldn't see the bad placement.
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!popup) {
      setPlacement(null);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = popup.anchor.x;
    let top = popup.anchor.y;
    // Horizontal shift: nudge inward if we'd run off the right edge.
    if (left + rect.width + VIEWPORT_PAD > vw) {
      left = Math.max(VIEWPORT_PAD, vw - rect.width - VIEWPORT_PAD);
    }
    if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
    // Vertical flip: prefer above the anchor if below would overflow
    // AND there's more room above. Fall back to shift if neither side
    // fits (menu taller than viewport — rare).
    if (top + rect.height + VIEWPORT_PAD > vh) {
      const above = popup.anchor.y - rect.height;
      if (above >= VIEWPORT_PAD) {
        top = above;
      } else {
        top = Math.max(VIEWPORT_PAD, vh - rect.height - VIEWPORT_PAD);
      }
    }
    if (top < VIEWPORT_PAD) top = VIEWPORT_PAD;
    setPlacement({ top, left });
  }, [popup]);

  if (!popup) return null;
  const pos = placement ?? { top: popup.anchor.y, left: popup.anchor.x };
  const visible = phase === 'open';
  const transition = `opacity ${EXIT_MS}ms ease, transform ${EXIT_MS}ms ease`;
  return (
    <>
      {/* Full-window backdrop catches clicks outside the menu. On a
          transparent Electron window macOS only routes mouse events to
          renderer pixels with enough alpha to read as opaque — a
          near-zero-alpha fill (we tried 0.01) silently falls through to
          the WebContentsView behind, so onMouseDown never fires. Match
          the OverlayRoot scrim's alpha so click-outside-to-close
          behaves the same as a modal's backdrop click; the two layers
          composite to a typical modal dim, which is the desired look
          anyway. */}
      <Box
        position="fixed"
        inset={0}
        zIndex={4999}
        style={{
          // Inline style so Chakra's token resolver can't strip the rgba —
          // we need a guaranteed non-zero alpha for macOS to deliver the
          // click to the transparent overlay WebContentsView. Match the
          // modal backdrop's alpha so we're past any OS threshold.
          background: 'rgba(0,0,0,0.4)',
          pointerEvents: 'auto',
          opacity: visible ? 1 : 0,
          transition: `opacity ${EXIT_MS}ms ease`,
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          closeWith(null);
        }}
      />
      <Box
        ref={menuRef}
        position="fixed"
        top={`${pos.top}px`}
        left={`${pos.left}px`}
        // Until the layout effect measures and commits a placement, hide
        // the menu to avoid a one-frame flash at the unadjusted anchor.
        visibility={placement ? 'visible' : 'hidden'}
        bg="#161b22"
        border="1px solid #30363d"
        borderRadius="6px"
        boxShadow="0 10px 30px rgba(0,0,0,0.5)"
        py="1"
        // Explicit width (not minW/maxW): in this Chakra setup the min/max
        // constraints weren't being honored and the menu grew to whatever
        // its parent allowed, so our right-edge measurement was way off.
        // A fixed width keeps placement math honest.
        width="240px"
        // Tall menus near the bottom edge should scroll inside the menu
        // rather than push past the viewport — combined with flip, this
        // keeps every item reachable.
        maxH={`calc(100vh - ${VIEWPORT_PAD * 2}px)`}
        overflowY="auto"
        zIndex={5000}
        style={{
          // Subtle slide-up + fade for entrance / exit. The dy is small
          // (4 px) so it reads as a "settle" rather than a swoop.
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(-4px)',
          transformOrigin: 'top left',
          transition,
        }}
      >
      {popup.items.map((item) => (
        <Box
          as="button"
          key={item.id}
          w="100%"
          textAlign="left"
          px="3"
          py="1.5"
          cursor={item.enabled === false ? 'not-allowed' : 'pointer'}
          opacity={item.enabled === false ? 0.5 : 1}
          // Explicit opaque bg (not "transparent"): on a transparent
          // Electron window macOS only routes mouse events to renderer
          // pixels that are opaque. The menu container is #161b22 but the
          // button's own paint layer also has to be opaque for clicks on
          // the button's rect to fire here instead of falling through.
          bg="#161b22"
          border="none"
          _hover={
            item.enabled === false
              ? {}
              : { bg: '#1f6feb', '& .popup-hint': { color: '#cce0ff' } }
          }
          onClick={() => {
            if (item.enabled === false) return;
            closeWith(item.id);
          }}
          onMouseDown={(e) => {
            // Stop the backdrop from receiving this mousedown via bubbling.
            e.stopPropagation();
          }}
        >
          <Text fontSize="12px" color="#f0f6fc">
            {item.label}
          </Text>
          {item.hint && (
            <Text className="popup-hint" fontSize="12px" color="#7d8590">
              {item.hint}
            </Text>
          )}
        </Box>
      ))}
      </Box>
    </>
  );
}
