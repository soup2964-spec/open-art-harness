import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Browser-driving code is exercised by the pilot/baseline runs, not by unit tests;
    // the only network the unit tests touch is a loopback HTTP server in interceptor.test.ts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
