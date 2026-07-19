---
name: pear-verify
description: >
  Run PEAR monorepo verification (typecheck, lint, format check, tests) after
  implementation and before every push. Use when finishing a task, before
  commit/PR/push, or when the user asks to verify, check work, or /pear-verify.
  Slash: /pear-verify
---

# PEAR Verify

## Pre-push gate (required)

**Do not push until all four pass.** Same gates as GitHub Actions CI.

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

One-liner:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

If `format:check` fails:

```bash
pnpm format
pnpm format:check
```

## What each gate covers

| Command             | Tool   | Scope                                                                           |
| ------------------- | ------ | ------------------------------------------------------------------------------- |
| `pnpm typecheck`    | tsgo   | all workspace packages with `typecheck` script                                  |
| `pnpm lint`         | Oxlint | repo root                                                                       |
| `pnpm format:check` | Oxfmt  | packages, examples, root config files                                           |
| `pnpm test`         | Vitest | Node (core + examples); then `@pear-agent/cloudflare` Workers pool when present |

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
6. **format:check fails** — run `pnpm format` (or oxfmt on the listed paths) before push.

## Done criteria

- All four gates green
- No new Core → Cloudflare imports
- Acceptance criteria for the current issue still hold (spot-check with tests)
- Only then commit/push or update the PR
