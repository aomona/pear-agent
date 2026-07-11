import { defineConfig } from "vitest/config";

/**
 * Root Node tests for core + examples.
 * Explicit includes avoid scanning local git worktrees under `.worktrees/`.
 * Cloudflare Workers tests run from packages/cloudflare when that package exists.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "examples/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.worktrees/**", "**/dist/**", "packages/cloudflare/**"],
    environment: "node",
    passWithNoTests: true,
  },
});
