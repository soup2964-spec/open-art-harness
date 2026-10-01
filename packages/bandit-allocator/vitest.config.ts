import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Every test file runs behind a guard that fails any real network attempt
    // (fetch, http/https, net/tls sockets, DNS). The allocator never needs the network.
    setupFiles: ['test/setup/no-network.ts'],
    // The simulation smoke test generates a few thousand synthetic users.
    testTimeout: 120_000,
  },
});
