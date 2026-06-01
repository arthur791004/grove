// Defers unmounting a component until an exit transition has run, so
// custom overlays (CommandPalette and friends) can fade out the same way
// PopupMenu does instead of disappearing on the same frame as the close.
//
// Returns:
//   mounted — keep the component in the tree (render gate)
//   visible — apply the "open" styles (animation target)
//
// Usage:
//   const { mounted, visible } = useFadePresence(open);
//   if (!mounted) return null;
//   <Box style={{ opacity: visible ? 1 : 0, transition: 'opacity 120ms ease' }} />

import { useEffect, useState } from 'react';

export const FADE_MS = 120;

export function useFadePresence(open: boolean, durationMs = FADE_MS): { mounted: boolean; visible: boolean } {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Wait one frame so the initial render commits with visible=false,
      // then flipping to true triggers the CSS transition from closed →
      // open. Without the rAF gap, both renders coalesce and the
      // transition no-ops.
      const id = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), durationMs);
    return () => clearTimeout(t);
  }, [open, durationMs]);
  return { mounted, visible };
}
