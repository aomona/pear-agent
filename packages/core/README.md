# `@pear-agent/core`

PEAR RuntimeのDomain、Goal、Actor、Capability Policy、Plan DAG、Execution Stateを定義する、環境非依存のFoundation packageです。

## Install

`@pear-agent/core`は現在privateなworkspace packageです。同じpnpm workspace内の利用側packageで次のように指定し、workspace rootで`pnpm install`してください。

```json
{
  "dependencies": {
    "@pear-agent/core": "workspace:*",
    "zod": "^4.3.5"
  }
}
```

Registry公開後は`pnpm add @pear-agent/core zod`で導入できる予定です。

## 最小Domain定義

```ts
import { defineDomain } from "@pear-agent/core";
import { z } from "zod";

const domain = defineDomain({
  id: "outing",
  version: 1,
  schemas: {
    input: z.object({ destination: z.string() }),
    normalizedInput: z.object({ destination: z.string() }),
    stepData: z.object({ label: z.string() }),
    // Domain schemas.worldState describes facts stored in WorldState.facts
    worldState: z.object({ ready: z.boolean() }),
    events: z.object({ type: z.literal("ready") }),
  },
  normalizeInput: async (input) => input,
  planning: {
    instructions: "出発準備を計画する",
    objectives: ["必要な準備を完了する"],
  },
  replanning: {
    instructions: "影響を受けた準備だけを更新する",
    defaultMode: "automatic",
  },
  capabilities: [],
  completionPolicy: "automatic",
});
```

Domain固有の状態はCoreの`WorldState` envelope（facts / resources / observations / constraints）の`facts`に載せます。`createWorldStateFromDomainFacts()`と`parseDomainWorldStateFacts()`でDomain schemaと往復できます。Runtimeの`domain_event`は`parseDomainEvent()`でDomain schemaへ検証できます。

## DAG検証

`validatePlanGraph()`は重複ID、存在しない依存先、循環を拒否します。

```ts
import { validatePlanGraph } from "@pear-agent/core";

const result = validatePlanGraph([
  { id: "pack", after: [] },
  { id: "leave", after: ["pack"] },
]);
```

## Step状態導出

`deriveStepStatuses()`は依存Stepが`completed`または`skipped`になるまでStepを`blocked`に保ち、実行可能になると`ready`を導出します。`transitionStep()`は許可された状態遷移だけを適用します。

```ts
import { deriveStepStatuses, type StepStates } from "@pear-agent/core";

const currentStates: StepStates = { pack: { status: "completed" } };
const states = deriveStepStatuses(
  [
    { id: "pack", after: [] },
    { id: "leave", after: ["pack"] },
  ] as const,
  currentStates,
);
```

## Execution State

`InMemoryExecutionStateRepository`はAdapterのcontract testにも使える参照実装です。初期状態を登録し、冪等性キー付きEventを追加すると、同じ操作内でmaterialized stateが更新され、最新Snapshotを取得できます。

```ts
import { InMemoryExecutionStateRepository } from "@pear-agent/core";

const repository = new InMemoryExecutionStateRepository();
await repository.create(initialState);

await repository.appendEvent({
  id: "event-1",
  sessionId: initialState.session.id,
  idempotencyKey: "pack-complete",
  actorId: "human-1",
  origin: "user",
  type: "step_completed",
  payload: { stepId: "pack" },
  occurredAt: new Date(),
});

const snapshot = await repository.getSnapshot(initialState.session.id);
// Snapshot recentEvents are windowed (default 100); pass { recentEventLimit } to override.
```

CoreはSession、WorldState、Runtime Event、Timer、materialized state、Snapshot、transactional Repository Portを提供します。Stepは`step_paused` / `step_skipped`、WorldStateは全文置換に加え`world_state_facts_patched`、Planは`plan_updated`（version増加、完了済み・実行中Stepの保護）で更新できます。`domain_event`は既定でobservationsへ記録します。

`InMemoryExecutionStateRepository`は永続ストアではありません。Cloudflare/D1への永続化、Voice Session、AI SDKによる計画・再計画、Continuationは後続Phaseで提供します。
