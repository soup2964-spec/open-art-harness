import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Every test file runs behind a guard that fails any real network attempt
    // (fetch, http/https, net/tls sockets, DNS). Audience sync is dry-run only.
    setupFiles: ['test/setup/no-network.ts'],
    testTimeout: 60_000,
  },
});
