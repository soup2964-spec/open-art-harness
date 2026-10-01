import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // DOM-facing suites opt in per file with `// @vitest-environment happy-dom`.
    include: ['*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
