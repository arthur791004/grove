// Lazy-mount wrapper for expensive children that don't need to be in the
// DOM while they're far from the viewport. Keeps a stable outer Box so
// the surrounding scroll position never jumps, and remembers the last
// measured height so the placeholder slot doesn't collapse the moment
// children unmount.
//
// Used by the terminal block list, which can grow to thousands of entries
// per tab. Each block's ANSI-decoded output is the costly child; the
// chrome around it is cheap, but rendering hundreds of <TerminalOutput>s
// at once eats CPU on every focus / store update / scroll.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Box } from '@chakra-ui/react';

interface Props {
  children: ReactNode;
  // How far above and below the viewport to start mounting / keep mounted.
  // Default keeps a screenful on each side so a fast scroll doesn't catch
  // an unmounted card mid-scroll.
  rootMargin?: string;
  // Render the children unconditionally — escape hatch for the first
  // mount before IntersectionObserver has fired, and for tests / SSR.
  forceMount?: boolean;
}

export function LazyMount({ children, rootMargin = '600px 0px', forceMount }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // `near` = the wrapper is within rootMargin of the viewport. Initially
  // true so the first paint includes the content (we don't know yet
  // whether the card is on-screen). The IO callback flips it once the
  // wrapper is observed.
  const [near, setNear] = useState(true);
  // Remember the most recent measured height so we can reserve the same
  // space when we unmount. Without this the placeholder would collapse
  // to 0 and the scroll position would jump.
  const [reservedHeight, setReservedHeight] = useState<number | null>(null);

  useEffect(() => {
    if (forceMount) return;
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setNear(e.isIntersecting);
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin, forceMount]);

  // Measure after children render. useLayoutEffect runs before paint so
  // the captured height is accurate even when the content is about to
  // unmount on the next state flip.
  useLayoutEffect(() => {
    if (!near && !forceMount) return;
    const el = wrapRef.current;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0) setReservedHeight(h);
  });

  const shouldMount = forceMount || near;
  return (
    <Box
      ref={wrapRef}
      style={
        shouldMount
          ? undefined
          : reservedHeight != null
            ? { minHeight: `${reservedHeight}px` }
            : undefined
      }
    >
      {shouldMount ? children : null}
    </Box>
  );
}
