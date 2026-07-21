# How PEAR works

PEAR is a durable control loop for applications that help people execute plans under changing conditions.

## Two flows, one boundary

### Compile

```text
Source upload → R2 bytes + D1 metadata
→ Interpret → Clarify? → Synthesize
→ Zod + Domain validation
→ versioned Plan Artifact → Review → Ready
```

A Plan Artifact is reusable, reviewable work definition. It is not yet a running session.

### Execute

```text
Ready Plan Artifact → Execution Session
→ Runtime Event → pure reducer
→ atomic D1 event + materialized-state update
→ WebSocket invalidation pulse → HTTP Snapshot refetch
```

An Execution Session is durable work state: plan version, step states, world state, timers, criteria, continuations, and recent events.

## The PEAR loop

| Phase   | Question                                                    | Durable output                            |
| ------- | ----------------------------------------------------------- | ----------------------------------------- |
| Plan    | What should happen, in what dependency order?               | Validated Plan DAG                        |
| Execute | What action occurred?                                       | Typed Runtime Event                       |
| Assess  | What changed in facts, resources, constraints, or criteria? | Updated materialized state                |
| Replan  | Which future work is actually affected?                     | Validated Plan Patch and new Plan Version |

State changes do not jump around this loop. User actions, tools, and models propose typed inputs; policy, authorization, schemas, and reducers decide what becomes durable.

## Source of truth

HTTP Snapshots are authoritative for clients. Agent WebSockets contain only invalidation metadata such as `revision` and `lastEventId`. This avoids maintaining competing state between the Durable Object connection and D1.

D1 stores the event log and materialized state. The event append and state update are atomic and idempotent. R2 stores source bytes; D1 stores source metadata and checksums.

## Host and Runtime ownership

| Host application owns                 | PEAR owns                      |
| ------------------------------------- | ------------------------------ |
| Domain schemas and policy             | portable Zod contracts         |
| authentication and authorization      | authorization hooks            |
| UI and routing                        | typed React clients and hooks  |
| provider credentials and model choice | provider-neutral AI adapters   |
| product-specific capabilities         | capability and event contracts |
| Cloudflare resources                  | D1/R2/Agent/Workflow adapters  |

This boundary keeps Core environment-independent and makes the host responsible for product decisions that a generic runtime cannot safely infer.

## Sessions are not connections

Execution Session is durable. Voice Session and WebSocket connections are ephemeral. Closing a browser, losing audio, or reconnecting a socket does not implicitly stop work. Continuations persist enough state to resume deliberately.

## Bounded replanning

A replan begins from cause Events and expands only through the affected downstream subgraph. Completed and skipped steps are immutable. Active-step changes require pause and human confirmation. The result is a Plan Patch with an auditable operation list, not an unstructured replacement plan.
