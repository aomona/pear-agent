---
name: pear-cloudflare
description: >
  Implement and change @pear-agent/cloudflare — Agents, D1+Drizzle, R2, PearRequestContext,
  authorization hooks, PlanGenerator, and Worker HTTP. Use when working on packages/cloudflare,
  wrangler, Miniflare/vitest-pool-workers, Raw Input form-data, or Issue #4 style adapters.
  Slash: /pear-cloudflare
---

# `@pear-agent/cloudflare`

## Architecture (fixed for v0.1)

```text
HTTP (Hono)
  → authorize(operation, PearRequestContext)
  → PlanGenerator (session create only; AI SDK in production)
  → ExecutionSessionAgent (serialize mutations per sessionId)
      → D1 via Drizzle (durable source of truth)
  → R2 for Raw Input bytes only
```

| Concern                                      | Location                                             |
| -------------------------------------------- | ---------------------------------------------------- |
| Durable state + event log + normalized input | **D1 + Drizzle** (`src/d1/`)                         |
| Mutation serialization                       | **ExecutionSessionAgent** (`src/agent/`)             |
| Raw blobs                                    | **R2** (`src/r2/`)                                   |
| Authn context + authz hook                   | Host injects into `createPearApp`                    |
| Plan generation                              | Host `PlanGenerator` (AI SDK later; static in tests) |

## Key files

- `src/d1/schema.ts` — Drizzle tables
- `src/d1/repository.ts` — `ExecutionStateRepository` + raw/normalized helpers
- `src/d1/client.ts` — `createPearDatabase`
- `migrations/0001_init.sql` — Wrangler / test migrations (keep in sync with schema)
- `src/agent/execution-session-agent.ts` — DO RPC surface
- `src/http/app.ts` — Hono routes
- `src/planner.ts` — `PlanGenerator` port
- `src/test-worker.ts` — Workers test entry
- `wrangler.jsonc` + `vitest.config.ts` — pool workers + `readD1Migrations`

## Conventions

1. **D1 is source of truth.** Agent rehydrates from D1; do not treat Agent SQL storage as primary PEAR state.
2. **Batch event + materialized update** in one D1 batch after pure `applyRuntimeEvent`.
3. **Dates:** Core schemas use `dateSchema` (Date | ISO → Date) on Core leaves only. Use `serializeJson` / `parseExecutionState` at D1 boundaries. Never revive Domain JSON by key name (`facts`, `domainData`, `normalizedInput` stay JSON-safe strings).
4. **Event ids are globally unique** in `runtime_events.id` (primary key). Prefer `${sessionId}-…` ids in tests.
5. **Raw Input:** `multipart/form-data` field `file` or `raw`; checksum + metadata in D1, body in R2.
6. **Session create:** `goal` + `normalizedInput` + `domainId` + `actorIds` → `PlanGenerator.generatePlan` → `buildInitialExecutionState` → Agent create.
7. **Unauthorized paths must not write** D1/R2. Throw `AuthorizationError`.
8. Core remains free of Cloudflare imports.

## HTTP surface (minimal)

| Method  | Path                                |
| ------- | ----------------------------------- |
| GET     | `/health`                           |
| POST    | `/sessions`                         |
| GET     | `/sessions/:id`                     |
| GET     | `/sessions/:id/snapshot`            |
| POST    | `/sessions/:id/events`              |
| POST    | `/sessions/:id/raw-inputs`          |
| GET     | `/sessions/:id/raw-inputs/:inputId` |
| PUT/GET | `/sessions/:id/normalized-input`    |

Default context header: `x-pear-context: {"actorId":"…","roles":[],"claims":{}}`.

## Tests

```bash
pnpm --filter @pear-agent/cloudflare exec vitest run
# or from root:
pnpm test   # node core tests, then cloudflare package tests
```

Workers tests need:

- `readD1Migrations` + `applyD1Migrations` setup (`src/test/apply-migrations.ts`)
- `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })`

Do not import `cloudflare:workers` from root Node Vitest projects.

## Host wiring sketch

```ts
export { ExecutionSessionAgent } from "@pear-agent/cloudflare";
const app = createPearApp({ authorize, planGenerator /* AI SDK */ });
export default { fetch: app.fetch };
```

Bindings: `DB`, `RAW_INPUTS`, `ExecutionSessionAgent` (SQLite migration class).

## Related skill

For general Cloudflare product choice / wrangler auth / deploy trees, use user skill **cloudflare-deploy** (`~/.grok/skills/cloudflare-deploy`). Prefer PEAR-specific rules in this skill when they conflict.
