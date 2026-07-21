# `@pear-agent/core`

Environment-independent contracts and pure Runtime logic.

```bash
pnpm add @pear-agent/core@beta zod
```

## Owns

- Zod schemas for Goal, Plan, Runtime Event, Execution State, Snapshot, Continuation, Voice, and Plan Patch;
- `defineDomain()` / `defineAiDomain()` contracts;
- Plan DAG validation, ordering, scheduling, presentation, and diff helpers;
- pure `applyRuntimeEvent()` materialized-state transitions;
- repository Ports and `InMemoryExecutionStateRepository` reference behavior;
- affected-subgraph analysis and immutable Plan Patch validation/application.

## Does not own

Cloudflare, React, the AI SDK, Gemini, authentication, product UI, or Domain-specific fields.

## Core invariant

Every durable state change enters as a typed Runtime Event and is reduced by pure logic before an adapter persists it. Models and tools can propose events; they cannot mutate state directly.

See [Define a Domain](/guide/domain) and the package [README](https://github.com/aomona/pear-agent/tree/dev/packages/core).
