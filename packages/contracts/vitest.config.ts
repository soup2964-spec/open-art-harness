import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The cohort determinism test generates the full default cohort twice.
    testTimeout: 60_000,
  },
});
