# Task 3 Review Report: Runtime Snapshot and Repository Transaction Port

## Scope and method

Reviewed `git diff --stat 5c6606b..8bdf37c` and the full unified diff in the
execution-state worktree. The already-reported test/typecheck/lint commands
were not rerun, per request; this is a read-only review of the implementation.

## Spec compliance

- `RuntimeSnapshot` exposes the requested plan, session, world state,
  plan-owned step-state projection, running timers, recent events, derived
  ready/active/blocked IDs, and `generatedAt` (`snapshot.ts:15-25`,
  `snapshot.ts:48-76`).
- `ExecutionStateRepository` exposes `create`, `get`, `appendEvent`, and
  `getSnapshot`; the in-memory adapter implements all four
  (`repository.ts:21-27`, `repository.ts:34-85`).
- Event and initial-state boundaries are Zod-parsed. Idempotency is scoped by
  the session selected from the event's `sessionId`, and a reducer failure
  occurs before either the event log or materialized state is changed
  (`repository.ts:57-74`).
- The added modules import only core modules and Zod; no Cloudflare, UI, AI SDK,
  or other forbidden runtime dependency was introduced.

## Findings

### Critical

None.

### Important

1. **Repository state and event records are exposed as mutable internals.**
   `get()` returns the map's live state (`repository.ts:53-55`), and both
   `appendEvent()` result variants return the live state and the exact event
   object stored in the event log (`repository.ts:65`, `repository.ts:74`). A
   caller can mutate `appliedIdempotencyKeys`, step statuses, or an event
   payload after the operation. That bypasses reducer validation/idempotency
   and can make the state and event log diverge, undermining the repository's
   atomic persistence boundary. Return defensive Zod-parsed clones (or expose
   readonly/frozen values) and keep the stored event separate from the value
   returned to callers.

2. **`createRuntimeSnapshot()` does not validate that its two state sources are
   coherent.** The function accepts an independent `plan` and
   `MaterializedExecutionState`, projects step states using the supplied plan,
   and parses the resulting shape (`snapshot.ts:42-76`), but never checks
   `state.plan` or that `plan.id/version` match `state.session.planId/version`.
   Passing a plan from another version/session can therefore produce a
   syntactically valid snapshot whose session references a different plan (and
   whose step IDs are projected from the wrong graph). Validate the materialized
   state at this boundary and assert plan/session identity/version consistency,
   or derive the snapshot plan solely from the state.

3. **The public snapshot schema does not constrain `activeTimers` to running
   timers.** `runtimeSnapshotSchema` uses `z.array(executionTimerSchema)`
   (`snapshot.ts:20`), so both the inferred `RuntimeSnapshot` type and
   `safeParse()` accept paused, completed, or cancelled timers in
   `activeTimers`. The factory happens to filter to `status === "running"`,
   but consumers validating or constructing snapshots through the public Zod
   boundary can still receive a contradictory read model. Use a running-timer
   schema/refinement for this field.

### Minor

None beyond the two correctness issues above. Retention/ordering policy for the
unbounded in-memory `recentEvents` list is an adapter concern and is not
specified by this task.

## Assessment

The implementation satisfies the requested snapshot fields, repository port,
session-scoped idempotency, reducer-before-append rollback behavior, public
Zod boundary, and core dependency boundary. It is **partially ready**: fix the
mutable-reference leak before treating `InMemoryExecutionStateRepository` as
a safe contract fixture, and enforce plan/session coherence before snapshots
are used as a resume/read model. No Critical findings were identified.

## Remediation

- Added structured-clone defensive copies at repository create, read, append,
  and snapshot boundaries so caller mutations cannot alter stored state or
  event payloads.
- `createRuntimeSnapshot()` now validates the materialized state and checks
  plan/session ID and version coherence before projection.
- Constrained `RuntimeSnapshot.activeTimers` to the running-timer schema and
  added regression coverage for malformed state, mismatches, and non-running
  timers.

## Verification

- `pnpm test` — 14 files, 97 tests passed.
- `pnpm typecheck` — passed for core and outing-domain workspaces.
- `pnpm lint` — passed.
- `git diff --check` — passed.
