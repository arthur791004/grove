import { defineConfig } from 'vitest/config';

// Compiled JS lives in dist/ alongside identical .test.js outputs; the source
// .ts tests are authoritative. Restricting `include` keeps vitest from
// double-loading them.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
