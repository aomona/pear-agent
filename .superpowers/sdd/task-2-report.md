# Task 2 Report: Timer and Materialized Execution State

## Status

Completed and committed.

## Implementation

- Added `ExecutionTimer` and its Zod schemas, with `running`, `paused`, `completed`, and `cancelled` statuses.
- Added `MaterializedExecutionState` and Zod schema. It materializes the session, plan, world state, step states, timers, criterion evaluations, event metadata, and idempotency metadata.
- Added pure `applyRuntimeEvent()` reducer. It never mutates the supplied state and returns the same state reference for duplicate event IDs or idempotency keys.
- Step events use the existing `transitionStep()` validation.
- Timer events support starting, pausing, resuming, and completing timers; invalid transitions and unknown timer operations throw explicit errors.
- `goal_evaluated` records the evaluation and completes the session only when `evaluateGoalCompletion()` is satisfied and every expected criterion has exactly one evaluation. Evaluation counts prevent duplicate or unknown criteria from satisfying a goal.
- Exported the new timer and reducer modules from the core package entry point.

## TDD evidence

1. Added the initial `step_completed` reducer test before either production module existed.
2. Confirmed RED with `Cannot find module './execution-state.js'`.
3. Added the minimal reducer/timer implementation and confirmed GREEN.
4. Added RED coverage for timer lifecycle, unknown timers, and goal completion; observed the expected missing timer/goal behavior failures.
5. Implemented only the corresponding reducer behavior and reran the tests.

## Tests and verification

All commands passed:

```text
pnpm vitest run packages/core/src/timer.test.ts packages/core/src/execution-state.test.ts
# 2 files passed, 8 tests passed

pnpm typecheck
# core and outing-domain passed

pnpm lint
# passed

git diff --check
# passed
```

## Self-review

- Verified duplicate event ID and duplicate idempotency-key applications return the unchanged state object.
- Verified reducer copies each changed branch and leaves the original step state intact.
- Verified terminal step transitions continue to be rejected by `transitionStep()`.
- Verified timer resume recalculates the end timestamp from stored remaining seconds.
- Verified missing, duplicate, and unknown goal evaluations cannot complete the session.

## Known concern

There is no `timer_cancelled` runtime event in the existing `RuntimeEvent` union, so the reducer cannot currently produce the `cancelled` timer status. The status is intentionally present in the public timer schema for forward compatibility.

## Handoff review (2026-07-11)

- Reviewed the uncommitted Task 2 implementation against the brief. The reducer is pure, delegates step validation to `transitionStep()`, applies event and idempotency-key deduplication, and enforces the timer and goal-evaluation behaviours required by the task.
- Re-ran the focused tests (8 passing), workspace typecheck, lint, and `git diff --check`; all passed.
- No implementation changes were required during the review.

## Important-findings correction (2026-07-11)

- Replaced the materialized state's cast-only `plan` field with `executionPlanSchema(z.unknown())`, so malformed plans are rejected at runtime by `safeParse`.
- Replaced the criterion-evaluation record and separate count bookkeeping with an append-only `CriterionEvaluation[]` history.
- Goal completion now has a single decision path: `evaluateGoalCompletion(plan.goal, criterionEvaluations)`. Its exact-set validation rejects missing, duplicate, and unknown criterion evaluations.
- Added coverage for invalid materialized plans, incomplete evaluation histories, and successful multi-criterion completion.
- Verification passed: `pnpm test -- packages/core/src/execution-state.test.ts` (12 files / 84 tests), `pnpm typecheck`, `pnpm lint`, and `git diff --check`.
