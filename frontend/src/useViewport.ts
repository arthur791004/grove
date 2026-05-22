import { useEffect, useState } from 'react';
import { IS_ELECTRON } from './env';

// iPhone / iPad-portrait breakpoint — the doc's ≤767px mobile tier. Matches
// Chakra's `base` band (its `md` token starts at 768px), so CSS-only responsive
// props using `{ base, md }` line up with whatever this hook reports.
const MOBILE_QUERY = '(max-width: 767px)';

// True when the viewport is phone-sized. Backed by matchMedia so it only
// re-renders on an actual breakpoint crossing, not on every resize tick.
//
// Always false in Electron: the desktop app keeps its layout (and icon sizes)
// no matter how the window is resized — the mobile tier is web-only.
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return !IS_ELECTRON && isMobile;
}
