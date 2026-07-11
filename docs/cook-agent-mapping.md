# cook-agentからPEAR Runtimeへの対応

## 方針

cook-agentをそのまま移植せず、既存実装から検証済みの概念を抽出します。PEAR Runtimeは外出準備サンプルによる縦切りを先に完成させ、その後PEAR Cookを第二のReference Applicationとして接続します。

## 引き継ぐ概念

| cook-agent            | PEAR Runtime                 | 方針                           |
| --------------------- | ---------------------------- | ------------------------------ |
| `PlanDocument`        | `ExecutionPlan<TDomainData>` | 料理固有フィールドを分離       |
| `PlanStep`            | `ExecutionStep<TStepData>`   | Executorと汎用Resourceを追加   |
| `timeline`            | Schedule / Duration          | Coreへ継承                     |
| `after`               | Dependencies                 | DAGとして継承                  |
| `req`                 | Resource Requirements        | 型を一般化                     |
| `PlanTimer`           | `TimerDefinition`            | Coreへ継承                     |
| `PlanVersion`         | `PlanVersion`                | 継承                           |
| `PlanPatch`           | `PlanPatch`                  | 実際の部分再計画へ発展         |
| `CookingSession`      | `ExecutionSession`           | 複数Actor・並行Step対応        |
| `CookSessionSnapshot` | `RuntimeSnapshot`            | WorldStateとContinuationを追加 |
| `SessionEvent`        | Core Event + Domain Event    | 固定Unionを分離                |
| `SessionTimer`        | `ExecutionTimer`             | Coreへ継承                     |
| Runtime Tool Call     | Capability Runtime           | Policyと認可を追加             |
| Runtime Replan        | Assess + Partial Replan      | Affected Subgraphだけ更新      |
| Gemini Live hook      | Gemini Voice Provider        | Execution Sessionから分離      |

## Cooking Domainへ残すもの

- Recipe Source
- HTML取得とレシピ抽出
- Normalized Recipe
- IngredientとMaterial
- Servings調整
- 食品安全ルール
- `prep`、`cook`、`finish`、`wait`、`cleanup`
- Stove、Oven、Knifeなどの具体的Resource
- Ingredient Shortage
- Cooking Mistake
- 複数料理を同時に完成させるPlanner指示
- 料理専用UI

## PEAR Runtimeで新しく実装するもの

- Goalと成功条件
- WorldState
- 複数Stepの並行実行状態
- ActorとAssignment
- Human / Agent / Wait Executor
- Capability Policy
- ContinuationとWake
- Voice Lease
- Snapshot Rehydration
- Raw InputのR2保存
- Domain Contract
- React hooks
- CLI
- 簡易Devtools

## そのまま引き継がない制約

### 単一`currentStepId`

cook-agentのRuntimeは単一の現在Stepを中心にしています。PEAR RuntimeではStepごとの状態を持ち、複数の`active` Stepを許可します。

### Event Unionへの料理概念の混在

`ingredient_shortage`や`mistake`をCore固定Unionへ含めません。Core EventとDomain Eventを分離します。

### 全体再生成によるRuntime Replan

cook-agentの現在の再計画はPlan全体を再生成し、新Versionへ差し替えます。PEAR RuntimeではImpact Analysis、Affected Subgraph、Plan Patchを実装します。

### React内のProvider State

Provider resume handleや接続状態をReactだけに保持しません。Execution Sessionに紐づく永続状態として保存します。

## コード再利用の判断基準

- PEAR Coreから料理用モジュールをimportしない
- Cloudflare Workersで利用できないNode固有処理をCoreへ持ち込まない
- 既存コードをコピーする場合も、PEARのSchemaと境界に合わせて再検証する
- cook-agentの挙動を回帰テストケースとして活用する
