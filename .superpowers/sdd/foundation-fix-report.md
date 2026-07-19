# PEAR Runtime Foundation Important Findings Fix Report

## Scope

- Goal completion now compares evaluations against the Goal's complete success-criterion set.
- Domain definitions now have an exported runtime schema factory and are validated by `defineDomain()`.
- The public design-plan example was updated for the Goal evaluator signature.

## TDD evidence

### RED

Command:

```sh
pnpm vitest run packages/core/src/goal.test.ts packages/core/src/domain.test.ts
```

Observed: 8 expected failures across the newly specified behavior. The failures covered the new Goal argument/exact criterion set and missing Domain runtime validation/schema factory.

### GREEN

Focused command:

```sh
pnpm vitest run packages/core/src/goal.test.ts packages/core/src/domain.test.ts
pnpm --filter @pear-agent/core typecheck
```

Observed: 18/18 focused tests passed and the core package typecheck exited successfully.

## Implementation

### Goal completion

`evaluateGoalCompletion(goal, evaluations)` returns `satisfied` only when:

- success-criterion IDs in the Goal are unique;
- every expected ID occurs exactly once in evaluations;
- no unknown or duplicate evaluation ID occurs; and
- every evaluation has status `satisfied`.

Regression coverage includes missing, duplicate, unknown, unsatisfied/unknown, empty, and complete valid evaluation sets.

### Domain validation

`executionDomainDefinitionSchema(schemas, capabilitySchemas)` validates:

- non-empty `id`;
- positive integer `version`;
- identity of the five supplied Zod schemas;
- `normalizeInput` as a function;
- non-empty planning/replanning instructions;
- one or more non-empty planning objectives;
- valid replanning default mode;
- capability definitions through the supplied capability schemas, including schema identity;
- completion policy.

`defineDomain()` constructs capability schemas from each definition and parses the complete definition before wrapping normalized-output validation. Literal IDs/versions and concrete Zod schema types remain inferred.

## Final verification

All commands exited 0:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm exec oxfmt --check packages/core/src/goal.ts packages/core/src/goal.test.ts packages/core/src/domain.ts packages/core/src/domain.test.ts docs/superpowers/plans/2026-07-11-pear-runtime-foundation.md
git diff --check
```

Results:

- Tests: 7 files passed, 59 tests passed.
- Typecheck: 2 workspace packages passed.
- Lint: no reported errors.
- Oxfmt: all 5 changed source/test/doc files correctly formatted.
- Frozen install and whitespace validation succeeded.

## Deferred / concerns

- `validatePlanGraph()` now uses an iterative DFS with an explicit stack, so deep plans no longer risk a `RangeError: Maximum call stack size exceeded` during schema parsing. A deep linear DAG is covered in tests.
- `wakeAt` is now validated as an ISO datetime (`z.iso.datetime`), and malformed timestamps are rejected at the plan-schema boundary with regression coverage.
- `successCriteria[].id` values must be unique at the `executionGoalSchema` boundary, so a Goal can no longer parse into a permanently unsatisfiable state.
- `executionDomainDefinitionSchema` rejects unexpected `schemas` keys in addition to asserting each expected schema identity.
- The Vitest workspace now includes `examples/*`, so example-domain tests execute in CI.
- npm build remains intentionally deferred as requested.
