import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { App } from './App';
import { startDaemonHealthMonitor } from './daemonHealth';
import './styles.css';

startDaemonHealthMonitor();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ChakraProvider value={defaultSystem}>
      <App />
    </ChakraProvider>
  </React.StrictMode>,
);
