import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Lazy-loaded built-in panels get stable filenames — no content
        // hash. electron-builder overwrites the packaged .app in place on
        // `npm run dist`, so hashed chunks invalidate the running
        // renderer's queued `import()` calls (ERR_FILE_NOT_FOUND on the
        // next panel switch). Stable names keep the URLs valid across
        // rebuilds; cache-busting isn't useful in a packaged app anyway.
        chunkFileNames: (info) => {
          const stable = new Set(['DiffPanel', 'FileBrowserPanel', 'BrowserPanel']);
          if (info.name && stable.has(info.name)) return `assets/${info.name}.js`;
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
