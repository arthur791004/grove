import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { App } from './App';
import { startDaemonHealthMonitor } from './daemonHealth';
import './styles.css';

// The overlay window (in Electron) loads this same bundle with ?overlay=1
// to render only the DOM modals above the WebContentsView. styles.css
// paints the body solid dark for the main window; in overlay mode we need
// the document transparent so the main window shows through wherever no
// modal is rendered. Setting the inline style overrides the .css rule.
if (typeof window !== 'undefined' && window.location.search.includes('overlay=1')) {
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  const root = document.getElementById('root');
  if (root) (root as HTMLElement).style.background = 'transparent';
}

// Skip in overlay mode — main renderer already runs this.
const IS_OVERLAY = typeof window !== 'undefined' && window.location.search.includes('overlay=1');
if (!IS_OVERLAY) startDaemonHealthMonitor();

// Mobile: when the iOS software keyboard opens, the visual viewport shrinks
// while the layout viewport doesn't — without this the keyboard covers the
// composer. Publish the keyboard height as a CSS var the layout reads.
function trackKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--keyboard-height', `${Math.round(inset)}px`);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
trackKeyboardInset();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ChakraProvider value={defaultSystem}>
      <App />
    </ChakraProvider>
  </React.StrictMode>,
);
