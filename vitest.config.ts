import { defineConfig } from "vitest/config";

/**
 * Root Node tests for core + examples.
 * Explicit includes/excludes avoid scanning local git worktrees under `.worktrees/`.
 * `@pear-agent/cloudflare` Workers tests run via packages/cloudflare/vitest.config.ts
 * (`pnpm --filter @pear-agent/cloudflare exec vitest run` from the root `test` script).
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "examples/**/src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.worktrees/**",
      "**/dist/**",
      "packages/cloudflare/**",
      // jsdom + React Testing Library — package vitest config
      "packages/react/**",
    ],
    environment: "node",
    passWithNoTests: true,
  },
});
