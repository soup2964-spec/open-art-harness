import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Every test file runs with the network guard: global fetch and every non-loopback
    // socket/DNS lookup fail the test (see test/setup/no-network.ts).
    setupFiles: ['test/setup/no-network.ts'],
    testTimeout: 30_000,
  },
});
