# Replan, resume, and voice

Add Runtime extensions only after Sources → Plan → Review → Execute works. Each extension crosses durable state and policy boundaries; none is just a UI toggle.

## Partial replanning

A replan is caused by new Events or changed facts. Runtime computes the affected downstream subgraph, asks the injected generator for a patch, then validates it against the current Plan, Domain version, event cursor, capability policy, and world state.

Modes:

| Mode        | Behavior                                                                         |
| ----------- | -------------------------------------------------------------------------------- |
| `automatic` | Apply only changes that remain safe under Runtime, Domain, and capability policy |
| `confirm`   | Persist a pending patch for human review and activation                          |
| `suggest`   | Return advisory output without activation                                        |

Completed and skipped steps cannot change. Active-step changes remain pending until affected work and timers are paused and a human confirms. Show `latestPlanChange` in the UI instead of reconstructing a diff from two whole plans.

## Continuations

A Continuation is a durable checkpoint for leaving and resuming an Execution Session. It records a wake condition, suspended reason, resume directive, and claim state.

Resume is an atomic claim:

```text
wake_pending → resuming → completed
                       ↘ resume-failed → wake_pending
```

This prevents two workers/clients from concurrently taking the same wake-up. A failed connection should return the continuation to a retryable state rather than pretending execution resumed.

## Voice

Voice is an ephemeral connection attached to a durable Execution Session.

1. acquire an exclusive Voice Lease;
2. request an ephemeral provider token from the Worker;
3. connect browser mic/speaker through `useVoiceSession()`;
4. route tool proposals back through the authorized Worker tool bridge;
5. persist provider resume handles;
6. release the lease without stopping execution.

`GEMINI_API_KEY` remains a Worker secret. The browser receives only an ephemeral token. Model tool calls must pass schemas, policy, authorization, and Runtime Event validation before they affect state.

## Recovery behavior

Design these states explicitly:

- replan generation/validation failure leaves the prior Plan active;
- stale patches are rejected by plan version and event cursor checks;
- a voice interruption flushes playback and keeps execution alive;
- suspend flushes the latest resume handle before disconnect when possible;
- a failed resume claim can be returned to `wake_pending`.

Extension tests should use fake generators and voice providers. CI should not call Gemini or browser media.
