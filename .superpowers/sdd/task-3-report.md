# Task 3 report: Runtime Snapshot and Repository Transaction Port

## Implemented

- Added `RuntimeSnapshot`, `runtimeSnapshotSchema`, and `createRuntimeSnapshot()`.
- Snapshot projection includes plan, session, world state, plan-owned step states,
  running timers, recent events, and derived ready/active/blocked step IDs.
- Added `ExecutionStateRepository` and `InMemoryExecutionStateRepository`.
- Repository append operations validate event envelopes, enforce session-scoped
  idempotency keys, and replace materialized state only after a successful pure
  reducer call. Failed events therefore leave both state and event log unchanged.
- Exported the new APIs from the core package index.

## Verification

- `pnpm vitest run packages/core/src` — 13 files, 92 tests passed.
- `pnpm typecheck` — passed for core and outing-domain workspaces.
- `pnpm lint` — passed.
- `pnpm format` — passed (the command also reformatted unrelated existing files;
  those files were intentionally not included in this task's commit).

## Commit

`8bdf37c feat(core): add runtime snapshots and repository port`

## Concerns

- The in-memory port is synchronous; callers may still use `await` on its return
  values, but a future remote adapter may choose an asynchronous contract.
- `recentEvents` currently returns the complete in-memory event log; retention or
  pagination policy belongs to a persistent adapter.
