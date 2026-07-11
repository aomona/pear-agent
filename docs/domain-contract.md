# Domain Contract

`defineDomain()`が返す公開型は`ExecutionDomainDefinition`です。Domainが生成する共通計画・Step・Goalには、それぞれ`ExecutionPlan`、`ExecutionStep`、`ExecutionGoal`を使用します。Stepの状態は`StepStatus`で表します。

## 目的

Domain Contractは、PEAR Runtimeへ用途固有の入力、計画指示、イベント、Capability、成功条件を接続する契約です。

## 基本形

```ts
const outingDomain = defineDomain({
  id: "outing",
  version: 1,

  schemas: {
    input: outingInputSchema,
    normalizedInput: normalizedOutingSchema,
    stepData: outingStepDataSchema,
    worldState: outingWorldStateSchema,
    events: outingEventSchema,
  },

  normalizeInput,

  planning: {
    instructions: outingPlannerInstructions,
    objectives: ["出発時刻までに必要な準備を完了する", "待機時間に並行可能な準備を進める"],
  },

  replanning: {
    instructions: outingReplannerInstructions,
    defaultMode: "automatic",
  },

  capabilities,
  completionPolicy: "automatic",
});
```

## 必須項目

### IDとVersion

Domain IDは永続データへ保存する安定した識別子です。VersionはSchemaやPlanner指示の互換性管理に使用します。

### Schema

すべての外部入力、AI出力、Domain EventはRuntime境界で検証します。

- Raw Input
- Normalized Input
- Step Domain Data
- Domain固有WorldState
- Domain Event
- Capability Input / Output

### `normalizeInput()`

Raw Inputの参照を受け取り、型付きNormalized Inputを返します。Raw Inputの取得、解析、外部API利用はDomainの責任です。

### Planning

開発者はSchema、instructions、objectivesを宣言します。PEAR RuntimeがAI SDKによる構造化Plan生成、再試行、検証を担当します。

### Replanning

開発者はDomain固有の再計画指示と標準Modeを宣言します。PEAR RuntimeがImpact Analysis、Patch生成、検証、Version保存を担当します。

### Capabilities

```ts
type CapabilityDefinition<TInput, TOutput> = {
  id: string;
  description: string;
  inputSchema: Schema<TInput>;
  outputSchema: Schema<TOutput>;
  executionMode: "automatic" | "confirm" | "suggest";
  riskLevel: "low" | "medium" | "high";
  execute(input: TInput, context: CapabilityContext): Promise<TOutput>;
};
```

CapabilityはPEAR Runtimeの認可とPolicy評価を通じて実行します。

### Authorization

認証Contextと操作単位の認可は後続PhaseでDomain Contractへ追加します。Foundationの`ExecutionDomainDefinition`にはまだ含まれません。

## RuntimeがDomainへ保証するもの

- Execution Planの共通Schema
- DAGとStep状態遷移
- ActorとAssignment
- Goal評価の実行基盤
- Capability Policy

Event追加とWorldState更新、認可、Continuation、Voice Session lifecycle、Plan Patch、Plan Version / Rollback、React hooksは後続Phaseで提供します。

## Domainが保証するもの

- SchemaがDomainの入力と出力を十分に表すこと
- Normalized InputがPlannerへ必要な情報を含むこと
- Planner指示がDomainの安全ルールを含むこと
- EventがWorldStateへ与える意味を定義すること
- Capabilityが冪等性または重複実行への対策を持つこと
- AI評価だけでは判断できない高リスク条件を明示すること

## v0.1で保証しないもの

- 任意のPlanner実装との互換性
- Domain間でのPlan合成
- 動的に取得した任意コードの実行
- Domain Marketplace
- Schema Versionの自動Migration
