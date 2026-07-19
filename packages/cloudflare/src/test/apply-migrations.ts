import { applyD1Migrations, env } from "cloudflare:test";

import type { PearEnv } from "../env.js";

type TestEnv = PearEnv & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

await applyD1Migrations(
  (env as unknown as TestEnv).DB,
  (env as unknown as TestEnv).TEST_MIGRATIONS,
);
