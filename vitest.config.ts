import { defineConfig } from "vitest/config";

/**
 * Root Vitest config for Node-side packages.
 * `@pear-agent/cloudflare` Workers tests run via packages/cloudflare/vitest.config.ts.
 */
export default defineConfig({
  test: {
    include: ["packages/core/src/**/*.test.ts", "examples/**/src/**/*.test.ts"],
    environment: "node",
  },
});
