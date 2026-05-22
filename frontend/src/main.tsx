import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { App } from './App';
import { startDaemonHealthMonitor } from './daemonHealth';
import './styles.css';

startDaemonHealthMonitor();

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
