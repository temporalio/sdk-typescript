import { defineConfig } from 'vitest/config';

// Each test file boots its own local Temporal dev server (`createLocal()`), so
// run files serially and allow generous timeouts for server + worker startup.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
