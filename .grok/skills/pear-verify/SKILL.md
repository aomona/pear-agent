---
name: pear-verify
description: >
  Run PEAR monorepo verification (typecheck, lint, format check, tests) after
  implementation. Use when finishing a task, before commit/PR, or when the user
  asks to verify, check work, or /pear-verify.
  Slash: /pear-verify
---

# PEAR Verify

## Commands (repo root)

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Optional format:

```bash
pnpm format   # Oxfmt write
```

## What each gate covers

| Command | Tool | Scope |
| --- | --- | --- |
| `pnpm typecheck` | tsgo | all workspace packages with `typecheck` script |
| `pnpm lint` | Oxlint | repo root |
| `pnpm test` | Vitest | Node: `packages/core`, `examples/*`; then `@pear-agent/cloudflare` Workers pool |

## Cloudflare package only

```bash
pnpm --filter @pear-agent/cloudflare typecheck
pnpm --filter @pear-agent/cloudflare exec vitest run
```

## Failure playbook

1. **Type errors in cloudflare agent stubs** — cast `getAgentByName` results; keep `PearEnv.ExecutionSessionAgent` loosely typed to avoid circular imports.
2. **Workers test `no such table`** — ensure migrations setup (`TEST_MIGRATIONS` + `applyD1Migrations`).
3. **Root Vitest loads `cloudflare:workers`** — cloudflare tests must not be in root `vitest.config.ts` include; only package-local config.
4. **Date / Zod 400 on events** — use `parseRuntimeEvent` / `parseJsonWithDates` for Core models; keep Domain payloads un-revived.
5. **Duplicate event on first append** — event `id` must be unique across D1 (not only per session).

## Done criteria

- All three gates green
- No new Core → Cloudflare imports
- Acceptance criteria for the current issue still hold (spot-check with tests)
