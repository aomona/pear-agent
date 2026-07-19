---
name: pear-runtime
description: >
  PEAR Runtime architecture and coding conventions for the pear-agent monorepo.
  Use when implementing issues, changing @pear-agent/core or Domain contracts,
  reading docs/, or when the user mentions PEAR Loop, Execution Session,
  WorldState, Plan DAG, Continuation, or Reference Applications.
  Slash: /pear-runtime
---

# PEAR Runtime

**Plan → Execute → Assess → Replan.** Execution Session is the source of work state; Voice Session is ephemeral.

## Before coding

1. Read the relevant docs under `docs/`:
   - `requirements.md` — FR / NFR and package boundaries
   - `architecture.md` — layers and Cloudflare vs Core
   - `lifecycle.md` / `state-model.md` — session, step, voice, continuation
   - `domain-contract.md` — `defineDomain()` contract
   - `implementation-roadmap.md` — phase order
2. Match the GitHub issue deliverables and acceptance criteria. Do not expand into later issues unless asked.
3. Prefer existing Core types/schemas over inventing parallel models.

## Package map

| Package                  | Role                                                  |
| ------------------------ | ----------------------------------------------------- |
| `@pear-agent/core`       | Environment-free models, reducers, Ports, Zod schemas |
| `@pear-agent/cloudflare` | Workers, Agents, D1, R2, auth hooks, HTTP             |
| `@pear-agent/react`      | Hooks (later)                                         |
| `create-pear-agent`      | CLI sample scaffold (later)                           |
| `examples/outing-domain` | First vertical sample Domain                          |

## Non-negotiables

- **Core never imports Cloudflare / React / Gemini / AI SDK.**
- Voice Session disconnect ≠ Execution Session stop.
- State changes go through Runtime events + pure reducers (`applyRuntimeEvent`), not ad-hoc mutation.
- Event append is **idempotent** (`id` + `idempotencyKey`) and **atomic** with materialized state.
- LLM Tool Calls do not mutate state directly; Runtime authorizes and applies.
- Cooking-specific concepts stay in Domain / PEAR Cook, not Core.
- Public types have Zod schemas; infer types from schemas when possible.
- Tooling: **Oxlint**, **Oxfmt**, **tsgo** (`@typescript/native-preview`), **Vitest**.

## Execution State (Core)

- Port: `ExecutionStateRepository` (`create` / `get` / `appendEvent` / `getSnapshot`)
- Reference: `InMemoryExecutionStateRepository`
- Materialized state holds session, plan, worldState, stepStates, timers, criterion evaluations, applied keys
- Snapshot is the resume/read model — not provider chat history

## Domain work

Use `defineDomain()` with schemas for input, normalizedInput, stepData, worldState facts, events.
Domain facts live in `WorldState.facts`. Planner/Replanner get instructions + objectives; Runtime owns structured generation later.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Cloudflare Workers tests run via the `@pear-agent/cloudflare` package Vitest config (separate from root Node tests).

## Out of scope reminders

Do not pull in Continuation/Wake (#7), Plan Patch (#8), React (#5), or Voice (#6) unless the current issue requires them. Prefer thin Ports and host-injected adapters.
