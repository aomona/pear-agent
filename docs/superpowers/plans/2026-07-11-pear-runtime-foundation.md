# PEAR Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CloudflareやReactへ依存しない`@pear-agent/core`と、型安全なDomain Contractをテスト付きで構築する。

**Architecture:** pnpm workspace内にCore packageと外出準備Domain fixtureを置く。CoreはZod Schema、純粋関数、明示的な状態遷移だけを提供し、永続化・AI SDK・Cloudflare統合は後続計画へ分離する。

**Tech Stack:** TypeScript、pnpm workspace、Zod、Vitest、Oxlint、Oxfmt、tsgo (`@typescript/native-preview`)

## Global Constraints

- TypeScriptはstrict modeを使用する。
- CoreからCloudflare、React、Gemini、AI SDKをimportしない。
- StepはDAGで表現し、複数Stepの`active`状態を許可する。
- 完了済みStepは変更不能とする。
- 公開APIには明示的な型とZod Schemaを用意する。
- LintはOxlint、FormatはOxfmt、Typecheckはtsgoを使用する。
- `@typescript/native-preview`はlockfileでVersionを固定する。
- テストを先に書き、各Taskを独立したコミットにする。

---

## File Map

```text
package.json                          workspace共通script
pnpm-workspace.yaml                  workspace定義
tsconfig.base.json                   strict TypeScript設定
vitest.workspace.ts                  package横断テスト設定
packages/core/package.json           @pear-agent/core manifest
packages/core/src/index.ts           公開API
packages/core/src/goal.ts            Goalと成功条件
packages/core/src/actor.ts           ActorとCapability Policy
packages/core/src/plan.ts            PlanとDAG検証
packages/core/src/step-state.ts      Step状態遷移
packages/core/src/domain.ts          Domain Contract
examples/outing-domain/src/domain.ts 外出準備Domain fixture
```

### Task 1: Workspaceと品質基盤

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: なし
- Produces: `pnpm typecheck`、`pnpm test`、`pnpm lint`、`@pear-agent/core`

- [ ] **Step 1: workspace manifestを作る**

```json
{
  "name": "pear-agent",
  "private": true,
  "packageManager": "pnpm@10.27.0",
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run --passWithNoTests",
    "lint": "oxlint .",
    "format": "oxfmt ."
  },
  "devDependencies": {
    "oxfmt": "^0.49.0",
    "oxlint": "^1.64.0",
    "@typescript/native-preview": "7.0.0-dev.20260702.3",
    "vite": "^8.0.12",
    "vitest": "^4.1.6"
  }
}
```

- [ ] **Step 2: workspaceとTypeScript設定を作る**

`pnpm-workspace.yaml`は`packages/*`と`examples/*`を含める。`tsconfig.base.json`は`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`を有効にする。各packageの`typecheck` scriptは`tsgo --noEmit -p tsconfig.json`とする。

- [ ] **Step 3: Core packageを作る**

`@pear-agent/core`はESM packageとし、`zod`だけをruntime dependencyにする。`src/index.ts`を公開入口にする。

- [ ] **Step 4: installと空の品質チェックを実行する**

Run: `pnpm install && pnpm typecheck && pnpm test`

Expected: `pnpm-lock.yaml`が生成され、Typecheckログにtsgoが使われ、すべて終了コード0。

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts .gitignore packages/core pnpm-lock.yaml
git commit -m "chore: initialize PEAR Runtime workspace"
```

### Task 2: Goalと成功条件

**Files:**

- Create: `packages/core/src/goal.ts`
- Create: `packages/core/src/goal.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: Zod
- Produces: `ExecutionGoal`、`SuccessCriterion`、`CriterionEvaluation`、`evaluateGoalCompletion()`

- [ ] **Step 1: 失敗テストを書く**

```ts
expect(
  evaluateGoalCompletion(goal, [
    { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
    { criterionId: "charged", status: "unknown", evidence: [], evaluatedAt: now },
  ]),
).toBe("incomplete");
```

- [ ] **Step 2: FAILを確認する**

Run: `pnpm vitest run packages/core/src/goal.test.ts`

Expected: `Cannot find module './goal'`でFAIL。

- [ ] **Step 3: Schemaと評価関数を実装する**

`ExecutionGoal`は必須の`id`、`description`、1件以上の`successCriteria`、`completionPolicy`と、任意の`deadline`、`priority`を持つ。Evaluatorは`human_confirmation`、`tool_result`、`state_rule`、`ai_evaluation`のdiscriminated unionにする。`evaluateGoalCompletion(goal, evaluations)`はGoalの全criterion IDが重複・欠落・未知IDなしでちょうど1回ずつ評価され、全評価が`satisfied`のときだけ`satisfied`を返す。

- [ ] **Step 4: 境界値テストを追加して実行する**

空配列、`unsatisfied`、全件`satisfied`、不正Schemaを追加する。

Run: `pnpm vitest run packages/core/src/goal.test.ts && pnpm typecheck`

Expected: PASS、型エラーなし。

- [ ] **Step 5: exportしてCommit**

```bash
git add packages/core/src/goal.ts packages/core/src/goal.test.ts packages/core/src/index.ts
git commit -m "feat(core): add goals and success criteria"
```

### Task 3: ActorとCapability Policy

**Files:**

- Create: `packages/core/src/actor.ts`
- Create: `packages/core/src/actor.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: Capability設定
- Produces: `ExecutionActor`、`StepAssignment`、`CapabilityDefinition`、`resolveExecutionMode()`

- [ ] **Step 1: Policyの失敗テストを書く**

```ts
expect(resolveExecutionMode({ configuredMode: "automatic", riskLevel: "high" })).toBe("confirm");
```

- [ ] **Step 2: FAILを確認する**

Run: `pnpm vitest run packages/core/src/actor.test.ts`

Expected: module未定義でFAIL。

- [ ] **Step 3: ActorとPolicyを実装する**

`ExecutionActor.kind`は`human | agent | system`、`ExecutionMode`は`automatic | confirm | suggest`、`RiskLevel`は`low | medium | high`とする。`StepAssignment.actorIds`は空配列を許可しない。高Riskの`automatic`は`confirm`へ引き上げる。

- [ ] **Step 4: 全ModeとRisk Levelをテストする**

Run: `pnpm vitest run packages/core/src/actor.test.ts && pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: exportしてCommit**

```bash
git add packages/core/src/actor.ts packages/core/src/actor.test.ts packages/core/src/index.ts
git commit -m "feat(core): add actors and capability policy"
```

### Task 4: Execution PlanとDAG検証

**Files:**

- Create: `packages/core/src/plan.ts`
- Create: `packages/core/src/plan.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: `ExecutionGoal`
- Produces: `ExecutionPlan<TStepData>`、`ExecutionStep<TStepData>`、`validatePlanGraph()`

- [ ] **Step 1: 循環DAGの失敗テストを書く**

```ts
expect(
  validatePlanGraph([
    { id: "a", after: ["b"] },
    { id: "b", after: ["a"] },
  ]),
).toEqual({ valid: false, reason: "cycle" });
```

- [ ] **Step 2: FAILを確認する**

Run: `pnpm vitest run packages/core/src/plan.test.ts`

Expected: module未定義でFAIL。

- [ ] **Step 3: Plan型とDAG検証を実装する**

`ExecutionStep`は`executor`、`after`、`requirements`、`estimatedDurationSeconds`、`timers`、`domainData`を持つ。Executorは`human`、Capability IDを持つ`agent`、Wake Conditionを持つ`wait`とする。`validatePlanGraph()`は重複ID、参照欠落、循環を判定する。

- [ ] **Step 4: 正常DAGと全エラーをテストする**

Run: `pnpm vitest run packages/core/src/plan.test.ts && pnpm typecheck`

Expected: 正常、重複、参照欠落、循環の4ケース以上がPASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plan.ts packages/core/src/plan.test.ts packages/core/src/index.ts
git commit -m "feat(core): add execution plan DAG"
```

### Task 5: Step状態遷移と並行実行

**Files:**

- Create: `packages/core/src/step-state.ts`
- Create: `packages/core/src/step-state.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: `ExecutionStep<TStepData>`
- Produces: `StepStatus`、`deriveStepStatuses()`、`transitionStep()`

- [ ] **Step 1: 並行readyの失敗テストを書く**

```ts
const states = deriveStepStatuses(
  [
    { id: "pack", after: [] },
    { id: "charge", after: [] },
    { id: "leave", after: ["pack", "charge"] },
  ],
  {},
);
expect(states.pack?.status).toBe("ready");
expect(states.charge?.status).toBe("ready");
expect(states.leave?.status).toBe("blocked");
```

- [ ] **Step 2: FAILを確認する**

Run: `pnpm vitest run packages/core/src/step-state.test.ts`

Expected: 関数未定義でFAIL。

- [ ] **Step 3: 状態遷移を実装する**

状態は`blocked | ready | active | paused | completed | failed | skipped`とする。既存の終端状態を維持し、依存Stepがすべて`completed`または`skipped`なら`ready`とする。`completed`と`skipped`からの遷移は禁止する。

- [ ] **Step 4: unblock、不正遷移、completed不変条件をテストする**

Run: `pnpm vitest run packages/core/src/step-state.test.ts && pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: 全チェックとCommit**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add packages/core/src/step-state.ts packages/core/src/step-state.test.ts packages/core/src/index.ts
git commit -m "feat(core): add parallel step state machine"
```

### Task 6: 型安全なDomain Contract

**Files:**

- Create: `packages/core/src/domain.ts`
- Create: `packages/core/src/domain.test.ts`
- Modify: `packages/core/src/index.ts`
- Create: `examples/outing-domain/package.json`
- Create: `examples/outing-domain/tsconfig.json`
- Create: `examples/outing-domain/src/domain.ts`
- Create: `examples/outing-domain/src/domain.test.ts`

**Interfaces:**

- Consumes: Zod Schema、`ExecutionMode`、`CapabilityDefinition`
- Produces: `defineDomain()`、`ExecutionDomainDefinition`

- [ ] **Step 1: Domain型推論の失敗テストを書く**

```ts
const domain = defineDomain({
  id: "outing",
  version: 1,
  schemas: {
    input: z.object({ departureAt: z.iso.datetime() }),
    normalizedInput: z.object({ departureAt: z.iso.datetime(), items: z.array(z.string()) }),
    stepData: z.object({ itemIds: z.array(z.string()) }),
    worldState: z.object({ packedItemIds: z.array(z.string()) }),
    events: z.discriminatedUnion("type", [
      z.object({ type: z.literal("delay"), minutes: z.number().positive() }),
    ]),
  },
  normalizeInput: async (input) => ({ ...input, items: [] }),
  planning: { instructions: "出発準備を計画する", objectives: ["期限を守る"] },
  replanning: { instructions: "影響範囲だけを更新する", defaultMode: "automatic" },
  capabilities: [],
  completionPolicy: "automatic",
});

expect(domain.id).toBe("outing");
```

- [ ] **Step 2: FAILを確認する**

Run: `pnpm vitest run packages/core/src/domain.test.ts`

Expected: `defineDomain`未定義でFAIL。

- [ ] **Step 3: Domain Contractを実装する**

`defineDomain()`は`id`、`version`、5種類のSchema、`normalizeInput`、planning instructions/objectives、replanning instructions/defaultMode、capabilities、completionPolicyを受け取り、その型を保持して返す。Objectivesは空配列を許可しない。

- [ ] **Step 4: 不正なNormalized Inputを拒否するテストを追加する**

Run: `pnpm vitest run packages/core/src/domain.test.ts && pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: 外出準備Domain fixtureを作る**

出発時刻、持ち物、充電状態、delay Eventを持つDomainを定義する。外部API、AI SDK、UIは含めない。

- [ ] **Step 6: workspace全体を検証する**

Run: `pnpm test && pnpm typecheck && pnpm lint`

Expected: Coreと外出準備fixtureの全テストがPASS。

- [ ] **Step 7: Commit**

```bash
git add packages/core examples/outing-domain
git commit -m "feat(core): add typed domain contract"
```

### Task 7: Foundation公開APIと文書

**Files:**

- Modify: `packages/core/src/index.ts`
- Create: `packages/core/README.md`
- Modify: `README.md`
- Modify: `docs/domain-contract.md`

**Interfaces:**

- Consumes: Task 2〜6の型と関数
- Produces: Foundationで保証する`@pear-agent/core`公開API

- [ ] **Step 1: package import smoke testを書く**

`@pear-agent/core`から`defineDomain`、`evaluateGoalCompletion`、`transitionStep`、`validatePlanGraph`をimportし、すべて関数であることを確認する。

- [ ] **Step 2: export不足を修正する**

`goal`、`actor`、`plan`、`step-state`、`domain`を`src/index.ts`から明示的にexportする。

- [ ] **Step 3: Core READMEを作る**

Install、最小Domain定義、DAG検証、Step状態導出を記載する。永続化、Voice、AI SDKは後続Phaseであることを明記する。

- [ ] **Step 4: 型名の整合性を確認する**

Run: `rg "ExecutionStep|ExecutionGoal|defineDomain|StepStatus" README.md docs packages/core/README.md`

Expected: 同じ概念に異なる公開型名が使われていない。

- [ ] **Step 5: 最終検証を実行する**

Run: `pnpm test && pnpm typecheck && pnpm lint`

Expected: 全コマンドが終了コード0。

- [ ] **Step 6: Commit**

```bash
git add packages/core README.md docs/domain-contract.md
git commit -m "docs: document PEAR Runtime foundation API"
```

## Foundation完了条件

- `@pear-agent/core`がCloudflare、React、Gemini、AI SDKへ依存しない
- Goal、Actor、Capability Policy、Plan DAG、並行Step状態、Domain Contractが公開される
- 外出準備Domain fixtureが型安全に定義できる
- 循環DAG、不正遷移、completed Stepの変更をテストが拒否する
- `pnpm test`、`pnpm typecheck`、`pnpm lint`が成功する
- 後続のExecution State計画がこの公開APIだけを利用できる
