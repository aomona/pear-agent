# Execution State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@pear-agent/core`にExecution Session、WorldState、Runtime Event、Timer、Runtime Snapshot、冪等な状態更新Portを追加する。

**Architecture:** 状態はEvent Logとmaterialized stateを分離する。CoreはイベントのSchema、純粋なreducer、Snapshot組み立て、Repository/transactionのPortだけを提供し、D1やCloudflare Agentの実装は次Issueへ委譲する。

**Tech Stack:** TypeScript、Zod、Vitest、tsgo、Oxlint、Oxfmt

## Global Constraints

- `@pear-agent/core`からCloudflare、React、Gemini、AI SDKをimportしない。
- 公開する型には対応するZod Schemaを用意し、型はSchemaから推論する。
- Event Logは追記専用であり、最新状態はmaterialized stateとして別に保持する。
- 状態更新とEvent追加は一つのtransaction Portで扱う。
- Commandにはidempotency keyを持たせ、同じkeyの再実行で状態を二重更新しない。
- Step状態は既存の`transitionStep()`だけを使って変更する。
- `evaluateGoalCompletion(goal, evaluations)`をGoal完了判定の唯一の経路にする。
- LintはOxlint、FormatはOxfmt、Typecheckはtsgoを使用する。

---

## File Map

```text
packages/core/src/session.ts              Session、Actor membership、Session status
packages/core/src/world-state.ts          facts、resources、observations、constraints
packages/core/src/event.ts                Event envelope、core payload、event reducer input
packages/core/src/timer.ts                timer modelと遷移
packages/core/src/execution-state.ts      materialized state、event application、snapshot
packages/core/src/repository.ts           transaction / repository Portsとin-memory fixture
packages/core/src/*test.ts                unit tests
packages/core/src/index.ts                public exports
examples/outing-domain/src/domain.ts      execution-stateを利用するfixture data
packages/core/README.md                   Execution State API usage
docs/requirements.md                      #3実装済み範囲の記録
```

### Task 1: Session、WorldState、Runtime EventのSchema

**Files:**

- Create: `packages/core/src/session.ts`
- Create: `packages/core/src/session.test.ts`
- Create: `packages/core/src/world-state.ts`
- Create: `packages/core/src/world-state.test.ts`
- Create: `packages/core/src/event.ts`
- Create: `packages/core/src/event.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Produces: `ExecutionSession`、`ExecutionSessionStatus`、`WorldState`、`RuntimeEvent`、`CoreRuntimeEvent`

- [ ] **Step 1: failing testsを書く**

```ts
expect(
  executionSessionSchema.safeParse({
    id: "session-1",
    planId: "plan-1",
    planVersion: 1,
    goalId: "goal-1",
    status: "active",
    actorIds: ["human-1"],
    createdAt: new Date(),
    updatedAt: new Date(),
  }).success,
).toBe(true);

expect(
  worldStateSchema.safeParse({
    facts: {},
    resources: [],
    observations: [],
    activeConstraints: [],
    updatedAt: new Date(),
  }).success,
).toBe(true);

expect(
  runtimeEventSchema.safeParse({
    id: "event-1",
    sessionId: "session-1",
    idempotencyKey: "step-1-complete",
    actorId: "human-1",
    origin: "user",
    type: "step_completed",
    payload: { stepId: "pack" },
    occurredAt: new Date(),
  }).success,
).toBe(true);
```

- [ ] **Step 2: failing testを確認する**

Run: `pnpm vitest run packages/core/src/session.test.ts packages/core/src/world-state.test.ts packages/core/src/event.test.ts`

Expected: new modules are not found.

- [ ] **Step 3: Schemaと型を実装する**

`ExecutionSessionStatus`は`not_started | active | paused | completed | cancelled`とする。Sessionは`planId`、`planVersion`、`goalId`、Actor IDs、created/updated timestampsを持つ。WorldStateはJSON-safe `facts`、resource state、observation、active constraintを持つ。

Runtime Eventの共通envelopeは`id`、`sessionId`、`idempotencyKey`、`actorId`、`origin`、`occurredAt`を必須にする。Core Eventは少なくとも`session_started`、`session_paused`、`step_started`、`step_completed`、`step_failed`、`timer_started`、`timer_paused`、`timer_completed`、`world_state_updated`、`goal_evaluated`をdiscriminated unionで表す。Domain Eventは`domain_event`、`domainType`、JSON-safe payloadを持つ別variantにする。

- [ ] **Step 4: invalid boundaryをテストする**

空のactor IDs、未知のsession status、空のevent idempotency key、未知event typeを拒否するテストを追加する。

- [ ] **Step 5: verify and commit**

Run: `pnpm vitest run packages/core/src/session.test.ts packages/core/src/world-state.test.ts packages/core/src/event.test.ts && pnpm typecheck && pnpm lint`

```bash
git add packages/core/src/session.ts packages/core/src/session.test.ts packages/core/src/world-state.ts packages/core/src/world-state.test.ts packages/core/src/event.ts packages/core/src/event.test.ts packages/core/src/index.ts
git commit -m "feat(core): add execution session state schemas"
```

### Task 2: TimerとMaterialized Execution State

**Files:**

- Create: `packages/core/src/timer.ts`
- Create: `packages/core/src/timer.test.ts`
- Create: `packages/core/src/execution-state.ts`
- Create: `packages/core/src/execution-state.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: `ExecutionSession`、`WorldState`、`RuntimeEvent`、`StepStates`
- Produces: `ExecutionTimer`、`MaterializedExecutionState`、`applyRuntimeEvent()`

- [ ] **Step 1: failing reducer testを書く**

```ts
const next = applyRuntimeEvent(initialState, {
  id: "event-1",
  sessionId: "session-1",
  idempotencyKey: "pack-complete",
  actorId: "human-1",
  origin: "user",
  type: "step_completed",
  payload: { stepId: "pack" },
  occurredAt: now,
});

expect(next.stepStates.pack).toEqual({ status: "completed" });
expect(next.appliedEventIds).toContain("event-1");
```

- [ ] **Step 2: failing testを確認する**

Run: `pnpm vitest run packages/core/src/timer.test.ts packages/core/src/execution-state.test.ts`

Expected: missing modules/functions.

- [ ] **Step 3: TimerとState reducerを実装する**

Timer statusは`running | paused | completed | cancelled`とする。Timerはduration、remaining seconds、started/ends timestampsを持つ。

`MaterializedExecutionState`はSession、WorldState、StepStates、Timer record、CriterionEvaluation record、lastAppliedEventAt、applied event IDsを持つ。`applyRuntimeEvent()`は入力を変更せず、新しいStateを返す。step Eventでは既存`transitionStep()`を呼び、timer Eventでは許可されたtimer遷移だけを実行する。

- [ ] **Step 4: reducerの安全性をテストする**

同一event ID、同一idempotency key、completed Stepへの不正遷移、存在しないtimerへの操作、paused timerのresume、timer completeをテストする。二重適用はstateを変えず、idempotent resultを返す。

- [ ] **Step 5: Goal評価をreducerへ接続する**

`goal_evaluated` eventでCriterionEvaluationを更新し、`evaluateGoalCompletion(plan.goal, evaluations)`が`satisfied`の場合だけSessionを`completed`へ遷移させる。評価欠落、重複、未知criterionではSessionを完了させないテストを追加する。

- [ ] **Step 6: verify and commit**

Run: `pnpm vitest run packages/core/src/timer.test.ts packages/core/src/execution-state.test.ts && pnpm typecheck && pnpm lint`

```bash
git add packages/core/src/timer.ts packages/core/src/timer.test.ts packages/core/src/execution-state.ts packages/core/src/execution-state.test.ts packages/core/src/index.ts
git commit -m "feat(core): add materialized execution state"
```

### Task 3: SnapshotとRepository Transaction Port

**Files:**

- Create: `packages/core/src/snapshot.ts`
- Create: `packages/core/src/snapshot.test.ts`
- Create: `packages/core/src/repository.ts`
- Create: `packages/core/src/repository.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: `ExecutionPlan`、`MaterializedExecutionState`、`RuntimeEvent`
- Produces: `RuntimeSnapshot`、`createRuntimeSnapshot()`、`ExecutionStateRepository`、`InMemoryExecutionStateRepository`

- [ ] **Step 1: failing snapshot and idempotency testsを書く**

```ts
const snapshot = createRuntimeSnapshot({ plan, state, recentEvents: [event] });
expect(snapshot.session.id).toBe("session-1");
expect(snapshot.plan.id).toBe("plan-1");
expect(snapshot.readyStepIds).toContain("charge");

const first = await repository.appendEvent(event);
const second = await repository.appendEvent({ ...event, id: "event-2" });
expect(first.kind).toBe("applied");
expect(second.kind).toBe("duplicate");
```

- [ ] **Step 2: failing testsを確認する**

Run: `pnpm vitest run packages/core/src/snapshot.test.ts packages/core/src/repository.test.ts`

Expected: missing modules/functions.

- [ ] **Step 3: Snapshotを実装する**

SnapshotはPlan、Session、WorldState、Step States、active timers、recent events、ready/active/blocked step IDs、generatedAtを含む。ready/active/blocked IDsはStep Stateから導出し、Planに存在しないstate keyは公開しない。

- [ ] **Step 4: Repository Portとin-memory implementationを実装する**

`ExecutionStateRepository`は`create(initialState)`、`get(sessionId)`、`appendEvent(event)`、`getSnapshot(sessionId)`を持つ。`appendEvent`は同一session内のidempotency keyを一意に扱い、event追加とmaterialized state更新を一つのrepository operationとして行う。In-memory implementationは後続Cloudflare Adapterのcontract test fixtureになる。

- [ ] **Step 5: transaction behaviorをテストする**

同じidempotency keyで異なるevent IDが来ても二重適用しないこと、別Sessionなら同じkeyを使えること、append失敗時にevent/stateが部分更新されないこと、Snapshotが最新Stateを返すことをテストする。

- [ ] **Step 6: verify and commit**

Run: `pnpm vitest run packages/core/src/snapshot.test.ts packages/core/src/repository.test.ts && pnpm typecheck && pnpm lint`

```bash
git add packages/core/src/snapshot.ts packages/core/src/snapshot.test.ts packages/core/src/repository.ts packages/core/src/repository.test.ts packages/core/src/index.ts
git commit -m "feat(core): add runtime snapshots and repository port"
```

### Task 4: Outing fixture、Documentation、Contract verification

**Files:**

- Modify: `examples/outing-domain/src/domain.ts`
- Modify: `examples/outing-domain/src/domain.test.ts`
- Modify: `packages/core/README.md`
- Modify: `docs/requirements.md`
- Modify: `docs/lifecycle.md`
- Create: `packages/core/src/execution-state.integration.test.ts`

**Interfaces:**

- Consumes: Tasks 1-3 public APIs
- Produces: Outing Domainの実行状態fixtureとCore end-to-end contract test

- [ ] **Step 1: integration testを先に書く**

外出準備Planで、独立した`pack`と`charge`がready、`pack`完了後も`charge`がactive、timer completeとgoal evaluation後にSessionがcompletedになる一連のテストを書く。

- [ ] **Step 2: failing testを確認する**

Run: `pnpm vitest run packages/core/src/execution-state.integration.test.ts`

Expected: Task 1-3 API接続前はFAIL。

- [ ] **Step 3: fixtureとdocumentationを更新する**

Outing fixtureにSession作成用のGoal、Plan、初期WorldStateを追加する。Core READMEにRepository→Event→Snapshotの最小例を追加する。要件とLifecycleには#3で完了した範囲を記録し、Cloudflare永続化は#4であることを明記する。

- [ ] **Step 4: full verificationを実行する**

Run: `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm lint && pnpm exec oxfmt --check packages/core examples/outing-domain package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts && git diff --check`

Expected: 全コマンドが終了コード0。

- [ ] **Step 5: Commit**

```bash
git add examples/outing-domain packages/core/README.md docs/requirements.md docs/lifecycle.md packages/core/src/execution-state.integration.test.ts
git commit -m "docs: demonstrate execution state runtime"
```

## Execution State完了条件

- Execution Session、WorldState、Runtime Event、Timer、Runtime SnapshotがZod Schemaとともに公開される。
- Event追加によりmaterialized stateが決定的に更新される。
- 同一idempotency keyは二重更新を起こさない。
- SnapshotはPlan、Session、WorldState、Step States、Timer、recent eventsを返す。
- Goal完了は`evaluateGoalCompletion(goal, evaluations)`だけを通じて判定される。
- CoreはCloudflare / React / Gemini / AI SDKをimportしない。
- Outing fixtureのintegration test、全test、tsgo、Oxlint、Oxfmtが成功する。
