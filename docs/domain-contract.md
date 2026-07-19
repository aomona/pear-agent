# Domain Contract

## 目的

Domainは用途固有の入力制約、interpretation/planning/replanning指示、Schema、validator、
Capabilityを宣言します。モデル呼び出し、retry、identity、provenance、永続化はRuntimeが担当します。

## 基本形

```ts
const domain = defineAiDomain({
  id: "cook",
  version: 1,
  schemas: {
    compileInput: cookCompileInputSchema,
    normalizedInput: normalizedCookInputSchema,
    stepData: cookStepDataSchema,
    worldState: cookWorldStateSchema,
    events: cookEventSchema,
  },
  interpretation: {
    instructions: "Extract recipes, ingredients, timings, dependencies, and equipment.",
  },
  planning: {
    instructions: "Create one resource-safe schedule that finishes dishes together.",
    objectives: ["Serve every dish on time", "Avoid equipment conflicts"],
    validatePlan,
    reconcilePlan,
  },
  replanning: {
    instructions: "Change only work affected by the recorded observation.",
    defaultMode: "confirm",
    reconcileWorldState,
  },
  realtime: {
    instructions: "Guide the current cooking step and use Runtime tools for changes.",
    defaultLocale: "ja-JP",
  },
  capabilities,
  completionPolicy: "automatic",
});
```

## SourceとCompile Input

SourceはRuntime共通の`text | url | file`です。Domain固有の提供時刻、人数、設備、
発表時間などは`schemas.compileInput`で表現します。`schemas.normalizedInput`は複数Sourceを
統合したDomain modelです。

## Interpretation

DomainはinstructionsとNormalized Input Schemaを提供します。`@pear-agent/ai`が標準
SourceInterpreterを構築します。特殊用途だけhostがInterpreter Portを差し替えます。
重大な不足はClarificationを返し、軽微な推測はassumptionとして記録します。

## Planning

AIはPlan候補を作成し、RuntimeがIDとsource refsを確定します。Domainの`validatePlan`は必須、
`reconcilePlan`は任意です。Reconcilerは時間合計やresource scheduleのように安全かつ
決定論的な補正だけを行い、新しい意味を創作してはいけません。

## EditingとReplanning

実行前編集は`{ kind: "full", plan }`からreview可能なfull-plan diffを作ります。実行中Replanは
部分的なPlanPatchを使い、Runtime Eventをtyped cause refとして持ちます。標準modeは`confirm`で、
より緩い要求にdown-gradeできません。

## Domainが保証するもの

- 全SchemaがJSON-safeな永続境界を表現する
- instructionsがDomainの安全ルールと判断基準を含む
- `validatePlan`がDomain固有invariantを網羅する
- Reconcilerが冪等で、意味を勝手に追加しない
- EventがWorldStateへ与える意味を定義する
- Capabilityがrisk/execution modeと重複実行対策を持つ

## Runtimeが保証するもの

- bounded AI generationとSchema validation
- Runtime-owned identityとStep単位provenance
- DAG、Step state、Capability policy、Domain invariant validation
- version、diff、confirmation、atomic activation、rollback
- Raw Source、Normalized Model、generation metadata、causeの追跡

## v0.1非目標

- Domain間のPlan合成
- 動的コード実行
- Domain Marketplace
- 自動Schema migration
- Provider完全互換
