// @cloudflare/vitest-pool-workers 0.22 targets vitest 4 and no longer ships
// `defineWorkersConfig` (the `/config` subpath was removed; see its bundled
// `codemods/vitest-v3-to-v4`). The v4 equivalent is the `cloudflareTest()` plugin
// inside vitest's own `defineConfig`, used here.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { TEST_SECRET, TEST_SECRET_PREVIOUS } from "./test/fixtures/secrets.js";

// wrangler.toml declares `[secrets] required = ["ATTRIBUTION_SECRET"]`; the pool's config
// loader looks for it in .dev.vars / process.env and warns when absent. Tests inject the
// binding below, so satisfy the check with the same test-only value.
process.env.ATTRIBUTION_SECRET ??= TEST_SECRET;

export default defineConfig({
  test: {
    projects: [
      {
        // Runs inside workerd (the Workers runtime) with the bindings from wrangler.toml.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: {
              bindings: {
                ATTRIBUTION_SECRET: TEST_SECRET,
                ATTRIBUTION_SECRET_PREVIOUS: TEST_SECRET_PREVIOUS,
                ORIGIN_OVERRIDE: "",
              },
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/worker/**/*.test.ts"],
        },
      },
      {
        // Runs in Node: the built dist/edge-sim.js (what the watchdog imports) and
        // provenance checks against the research evidence files.
        test: {
          name: "node",
          environment: "node",
          include: ["test/node/**/*.test.ts"],
        },
      },
    ],
  },
});
