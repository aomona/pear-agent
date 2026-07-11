# `@pear-agent/core`

PEAR RuntimeのDomain、Goal、Actor、Capability Policy、Plan DAG、Step状態を定義する、環境非依存のFoundation packageです。

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

このFoundationには永続化、Voice Session、AI SDKによる計画・再計画は含まれません。これらは後続Phaseで提供します。
