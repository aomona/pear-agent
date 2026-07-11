# PEAR Agent — Project Rules

## Product

PEAR Runtime helps developers build real-world execution support apps on Cloudflare.
Loop: **Plan → Execute → Assess → Replan**.
Execution Session is durable work state; Voice Session is a temporary connection.

## Docs first

Primary specs live in `docs/` (`requirements.md`, `architecture.md`, `lifecycle.md`, `domain-contract.md`, `state-model.md`, `implementation-roadmap.md`).
Read the issue + matching FR before implementing. Stay within the issue boundary.

## Stack

- TypeScript monorepo (pnpm)
- Core: Zod, pure reducers, Ports
- Cloudflare: Workers, Agents/DO, D1 + **Drizzle**, R2, Hono
- Tooling: Oxlint, Oxfmt, tsgo, Vitest (`@cloudflare/vitest-pool-workers` for Workers)

## Boundaries

1. `@pear-agent/core` must not depend on Cloudflare, React, Gemini, or AI SDK.
2. Cloudflare-specific code stays in `@pear-agent/cloudflare`.
3. Domain/cooking concepts stay in Domain packages or samples, not Core.
4. Prefer host-injected Ports (`PlanGenerator`, `authorize`) over baking AI/auth into Core.

## Pre-push gate (required)

**Do not `git push` (or open/update a PR expecting CI) until all four pass locally.**  
These match GitHub Actions CI on `main` / `dev`.

```bash
pnpm typecheck      # tsgo
pnpm lint           # oxlint
pnpm format:check   # oxfmt --check (packages, examples, root configs)
pnpm test           # vitest (Node) + @pear-agent/cloudflare Workers tests when present
```

Rules for agents and humans:

1. Run the four commands above after implementation and before every push.
2. If `format:check` fails, run `pnpm format` (or `pnpm exec oxfmt <paths>`) and re-check.
3. Fix failures; do not push broken typecheck, lint, format, or tests “to see CI”.
4. Prefer the same order as CI: typecheck → lint → format:check → test.

Optional one-liner:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

## Skills (project)

Use project skills under `.grok/skills/` (no superpowers workflow required):

- `/pear-runtime` — architecture & Core conventions
- `/pear-cloudflare` — Workers / D1 / R2 / Agent adapter
- `/pear-verify` — verification gates (aligns with the pre-push gate)

User-level `cloudflare-deploy` is available for general Cloudflare platform deploy guidance.
