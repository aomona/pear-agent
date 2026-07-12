# Core 拡張候補 — cook-agent 相当体験に向けて

## 目的

cook-agent で実証済みの「計画を作り・見せ・直し・実行する」体験を、PEAR 上で **料理以外の Domain でも**再現するために、`@pear-agent/core` へ載せるべき拡張を列挙する。

本ドキュメントは **設計カタログ**であり、即実装の Issue 分割ではない。実装時は [cook-agent-mapping.md](./cook-agent-mapping.md)、[requirements.md](./requirements.md)、[domain-contract.md](./domain-contract.md) と突き合わせて範囲を切る。

## 前提と境界

### cook-agent が強いところ / PEAR が強いところ

| 領域                 | cook-agent                            | PEAR Runtime（現状）              |
| -------------------- | ------------------------------------- | --------------------------------- |
| 計画生成             | AI structured plan + stream + improve | Port のみ、sample は static       |
| 計画の可読性         | timeline / 材料 / 工程カード          | Step id + 見積もり秒              |
| 資源スケジューリング | `req` 量 + leveling                   | 資源 id 列挙のみ                  |
| 実行中の並行         | 単一 current step 寄り                | 複数 active Step                  |
| 部分再計画           | 全体 improve 寄り                     | Assess + Subgraph + Plan Patch    |
| 中断・再開           | 限定的                                | Continuation / Wake / Voice Lease |

### Core に載せるもの / 載せないもの

**Core に載せる**

- 複数 Domain で同じ意味を持つ実行モデル
- Schema・検証・純関数（DAG、スケジュール、Patch 適用、表示用の正規化）
- Port の型（Planner / Improver / Scheduler の入出力契約）

**Core に載せない（Domain / App / Adapter）**

- レシピ、材料名、食品安全、`prep|cook|finish` など料理固有 enum
- HTML 取得、Tavily、人数調整のプロンプト
- 認証 UI、Plan 一覧の Next.js 画面、タイムラインの具体コンポーネント
- AI SDK / Gemini / OpenAI の実装（Adapter が Port を満たす）

### 設計原則

1. **料理を Core に染み込ませない** — cooking は第二 Reference Application。
2. **既存の `ExecutionPlan` / `ExecutionStep` を壊さない** — フィールド追加は optional から。
3. **表示用と実行用を混ぜすぎない** — UI 文言は optional、DAG / 状態遷移は必須のまま。
4. **Planner は Port** — Core は Schema と検証、生成は host。
5. **cook の JSON Patch と PEAR の Plan Patch を混同しない** — 実行中の部分更新は既存 `PlanPatch` を正とする。

---

## 拡張機能リスト

優先度:

- **P0** — cook 相当の「計画→実行」デモに必須
- **P1** — 計画品質・編集体験に必要
- **P2** — 本格アプリ / 第二 Domain 向け
- **P3** — 将来・ niceties

---

### CE-01 Step の人向け表示フィールド

|               |                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| **優先度**    | P0                                                                                                             |
| **cook 由来** | `PlanStep.label`, `instructions`, `notesForUser`                                                               |
| **現状の穴**  | Core Step は `id` 中心。UI/Voice が読める共通フィールドがない                                                  |
| **Core 案**   | `ExecutionStep` に optional: `label?: string`, `summary?: string`, `instructions?: string`, `notes?: string[]` |
| **検証**      | 空文字拒否、長さ上限（例: label 160, instructions 2000）                                                       |
| **非目標**    | 多言語 i18n マップ、Markdown AST                                                                               |

Voice と UI が同じ指示文を参照できるようにする。Domain 固有の長文は引き続き `domainData` 可。

---

### CE-02 構造化 Timer 定義

|               |                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| **優先度**    | P0                                                                                                              |
| **cook 由来** | `PlanTimer`（id, label, seconds, autoStart）                                                                    |
| **現状の穴**  | `timers: unknown[]`。autoStart / 表示ラベルが未契約                                                             |
| **Core 案**   | `timerDefinitionSchema`: `{ id, label?, durationSeconds, autoStart?, linkedStepId? }` を Step.timers の要素型に |
| **検証**      | id 一意（Plan 内）、duration ≥ 0、linkedStepId は存在する Step                                                  |
| **非目標**    | 壁時計アラーム、cron                                                                                            |

実行時 `ExecutionTimer` との対応（definition id → runtime timer id）を明文化する。

---

### CE-03 量付きリソース要件（Resource Requirements）

|               |                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **優先度**    | P1                                                                                                                                                |
| **cook 由来** | `req: Record<string, number>`（例: stove: 1）                                                                                                     |
| **現状の穴**  | `requirements: string[]` は「要る/要らない」だけ                                                                                                  |
| **Core 案**   | `ResourceRequirement = { resourceId: string, quantity: number }` または `Record<string, number>` を Step に追加（移行期は `requirements` と両立） |
| **検証**      | quantity > 0、resourceId 非空、キー一意                                                                                                           |
| **非目標**    | 物理単位系、在庫 SKU                                                                                                                              |

WorldState.resources の「利用可能量」と突合する policy の入力型になる。

---

### CE-04 Step タイムライン（相対スケジュール）

|               |                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| **優先度**    | P1                                                                                                      |
| **cook 由来** | `timeline: { start, end }`（分単位の相対時刻）                                                          |
| **現状の穴**  | `estimatedDurationSeconds` のみ。Gantt / 「同時に何が走るか」が計算できない                             |
| **Core 案**   | optional `timeline?: { startOffsetSeconds: number, endOffsetSeconds: number }` または minute 単位の別名 |
| **検証**      | end > start、`estimatedDurationSeconds` と整合（許容誤差を定義）                                        |
| **非目標**    | 絶対時刻カレンダー、タイムゾーン変換（絶対時刻は Session 開始時刻 + offset で App 側）                  |

表示と scheduler の入力。DAG の `after` と矛盾する場合の解決は CE-05。

---

### CE-05 Plan Scheduler（純関数）

|               |                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| **優先度**    | P1                                                                                                      |
| **cook 由来** | `lib/plans/scheduler.ts`（依存 ready + 資源 leveling）                                                  |
| **現状の穴**  | Core にスケジュール計算がない                                                                           |
| **Core 案**   | `schedulePlan(plan, options) → { plan, conflicts, criticalPath? }`                                      |
| **入出力**    | 入力: DAG + duration + resource requirements + capacity map。出力: 各 Step の timeline 埋め、衝突リスト |
| **検証**      | 循環なし、capacity 超過を detect または resolve                                                         |
| **非目標**    | オンライン再最適化の重い ILP、リアルタイム OS スケジューラ                                              |

**純関数のみ** Core に置く。AI が雑に出した timeline を正規化する用途が主。

---

### CE-06 Plan Presentation モデル

|               |                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **優先度**    | P0                                                                                                                                      |
| **cook 由来** | `presentation.ts`, `timeline.ts`                                                                                                        |
| **現状の穴**  | React が生の Plan を直接表示。レーン分割・クリティカルパスが共通化されていない                                                          |
| **Core 案**   | 純関数: `buildPlanPresentation(plan, stepStates?) → { lanes, nodes, edges, totalDurationSeconds, readyIds, blockedIds, criticalPath? }` |
| **非目標**    | React コンポーネント、色テーマ                                                                                                          |

UI は描画だけ。cook の timeline UI を PEAR に移植するときの入力型になる。

---

### CE-07 Plan メタデータとタイトル

|               |                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------- |
| **優先度**    | P0                                                                                             |
| **cook 由来** | `PlanDocument.title`, `metadata`（機材、制約、source ids）                                     |
| **現状の穴**  | Plan は `id/version/goal/steps` のみ。一覧・編集画面用の人間向けタイトルがない                 |
| **Core 案**   | optional `title?: string`, `metadata?: Record<string, JsonValue>`（または typed loose object） |
| **検証**      | title 長さ、metadata JSON-safe                                                                 |
| **非目標**    | 任意の巨大 blob を Event に毎回載せる                                                          |

Domain 固有の詳細は metadata か Domain package。Core は「ある」ことだけ保証。

---

### CE-08 Planner Port（生成契約の Core 化）

|               |                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| **優先度**    | P0                                                                                                                 |
| **cook 由来** | `generateCookingPlan`, structured output schema                                                                    |
| **現状の穴**  | `PlanGenerator` は `@pear-agent/cloudflare` 側。Core / Domain 契約と未統合                                         |
| **Core 案**   | Core Port: `PlanGenerator.generate(input: { domainId, goal, normalizedInput, planning, context }) → ExecutionPlan` |
| **関連**      | Domain の `planning.instructions` / `objectives` を入力に必須化                                                    |
| **非目標**    | OpenAI/Gemini 実装、ストリームチャンクの wire format（CE-09）                                                      |

Cloudflare の host 注入は Adapter がこの Port を実装する形に揃える。

---

### CE-09 Plan Improvement Port

|               |                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| **優先度**    | P1                                                                                                              |
| **cook 由来** | `improveCookingPlan` / `streamImproveCookingPlan`                                                               |
| **現状の穴**  | 実行前の「この計画を直して」がない。実行中は Replan のみ                                                        |
| **Core 案**   | `PlanImprover.improve({ basePlan, request, normalizedInput, goal, constraints? }) → ExecutionPlan \| PlanPatch` |
| **検証**      | 返却 Plan は通常の plan schema + DAG 検証                                                                       |
| **非目標**    | チャット UI、diff エディタ                                                                                      |

実行前 improve と実行中 partial replan を明示的に分ける（後者は既存 Replan 系）。

---

### CE-10 Plan 生成ストリームの抽象（イベント型のみ）

|               |                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| **優先度**    | P2                                                                                                              |
| **cook 由来** | SSE / progress modal                                                                                            |
| **現状の穴**  | 生成進捗の共通イベント型がない                                                                                  |
| **Core 案**   | `PlanGenerationProgressEvent` union: `started \| tool_call \| partial_plan \| validated \| failed \| completed` |
| **非目標**    | SSE 実装、HTTP ルート                                                                                           |

Adapter が stream を運ぶ。Core は型と終端条件だけ。

---

### CE-11 Plan Artifact（Session から独立した計画エンティティ）

|               |                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **優先度**    | P1                                                                                                                          |
| **cook 由来** | `plans` テーブル、下書き→確定→実行                                                                                          |
| **現状の穴**  | Plan は Session 作成時に生成され、計画ライブラリがない                                                                      |
| **Core 案**   | `PlanArtifact = { id, domainId, status: draft\|ready\|archived, currentPlan, version, createdAt, updatedAt, title?, goal }` |
| **Port**      | `PlanRepository`（create / get / list / saveVersion）— 実装は Adapter                                                       |
| **非目標**    | マルチテナント ACL の詳細（認可は host）                                                                                    |

Execution Session は `planArtifactId` + immutable plan version を参照するモデルへ拡張可能。

---

### CE-12 Plan Version 履歴の Core モデル強化

|                  |                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| **優先度**       | P1                                                                                               |
| **cook 由来**    | version 行 + `patch_from_parent`                                                                 |
| **現状の穴**     | D1 に Plan Version はあるが Core の第一級モデル・差分要約が弱い                                  |
| **Core 案**      | `PlanVersionRecord { planId, version, plan, parentVersion?, changeReason, summary?, createdAt }` |
| **changeReason** | `initial \| improve \| runtime_replan \| user_edit \| rollback`                                  |
| **非目標**       | git 風 branch / merge                                                                            |

既存 partial replan の version 採番と揃える。

---

### CE-13 実行前 Plan Patch と JSON 編集の橋渡し

|               |                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **優先度**    | P2                                                                                                                              |
| **cook 由来** | JSON Patch 風 `PlanPatchOperation`（add/remove/replace/move）                                                                   |
| **現状の穴**  | PEAR `PlanPatch` は実行時 step 単位 op（add_step / update_step / remove_step）                                                  |
| **Core 案**   | 維持: 実行時は現行 `PlanPatch`。任意: `documentPatchToPlanOperations` の変換ヘルパ、または **編集用** `PlanEditOp` を別型で定義 |
| **非目標**    | RFC6902 完全実装を実行パスに持ち込む                                                                                            |

実行中安全性（完了 Step を戻さない等）は現行 replan 検証を正とする。

---

### CE-14 材料・生成物の汎用リンク（Material Links）

|               |                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **優先度**    | P2                                                                                                                                                                             |
| **cook 由来** | `uses`, `outputs`, `materials[]`                                                                                                                                               |
| **現状の穴**  | 工程とモノの関係が Domain ごとにバラバラ                                                                                                                                       |
| **Core 案**   | optional `consumes?: string[]`, `produces?: string[]` on Step（id 参照）。Plan レベル `items?: PlanItem[]` は **Domain 推奨型**として document 化し、Core 必須にはしない案も可 |
| **推奨分割**  | 最小リンクだけ Core、材料マスタは Domain                                                                                                                                       |
| **非目標**    | 栄養計算、在庫 ERP                                                                                                                                                             |

外出準備なら `consumes: ['phone']`、料理なら ingredient id。

---

### CE-15 Step 分類タグ（汎用）

|               |                                                                   |
| ------------- | ----------------------------------------------------------------- |
| **優先度**    | P2                                                                |
| **cook 由来** | `kind`, `tags`                                                    |
| **現状の穴**  | フィルタ・色分けの共通軸がない                                    |
| **Core 案**   | `tags?: string[]`（汎用）。`kind` は Domain enum を domainData に |
| **非目標**    | 固定グローバル taxonomy                                           |

---

### CE-16 Resource Capacity モデル

|               |                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| **優先度**    | P1                                                                                                           |
| **cook 由来** | available equipment / concurrent stove count                                                                 |
| **現状の穴**  | WorldState.resources はあるが「同時利用 capacity」契約が薄い                                                 |
| **Core 案**   | `ResourceCapacity { id, capacity: number, mode?: exclusive\|shared }` と、scheduler / reconcile 用の突合関数 |
| **非目標**    | 動的リースの分散ロック実装（実行時は Adapter）                                                               |

---

### CE-17 Goal と Plan の一体生成契約

|               |                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **優先度**    | P1                                                                                                                                    |
| **cook 由来** | 計画が servings 等のゴール条件を内包                                                                                                  |
| **現状の穴**  | Goal は手渡し、Plan 生成が goal とズレうる（現状は id 一致チェック程度）                                                              |
| **Core 案**   | `generatePlan` 結果に goal を含める現状を維持しつつ、`assertPlanMatchesGoal(plan, goal)` を強化（criteria id 集合、completionPolicy） |
| **非目標**    | Goal の自然言語からの自動分解（AI Adapter）                                                                                           |

---

### CE-18 成功条件評価の実行ヘルパ拡充

|               |                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **優先度**    | P1                                                                                                                                       |
| **cook 由来** | 完了判定の実務                                                                                                                           |
| **現状の穴**  | evaluator 型はあるが Domain の state_rule 実装パターンが薄い                                                                             |
| **Core 案**   | `evaluateStateRule(criterion, worldState, plan, stepStates) → CriterionEvaluation` のフック型、または Domain が渡す `GoalEvaluator` Port |
| **非目標**    | LLM 評価のプロンプト                                                                                                                     |

outing の packed/charged も同じ枠でデモできる。

---

### CE-19 Assignment（Step ↔ Actor）

|               |                                                                     |
| ------------- | ------------------------------------------------------------------- |
| **優先度**    | P2                                                                  |
| **cook 由来** | 単一ユーザー中心だが、将来の分担に相当                              |
| **現状の穴**  | FR-04 で Assignment があるが Core の第一級操作が弱い                |
| **Core 案**   | `StepAssignment { stepId, actorIds[] }` と Event、Snapshot への反映 |
| **非目標**    | 共同編集 UI（要件どおり v0.1 外でも可）                             |

---

### CE-20 Wait Executor と Timeline の統合

|               |                                                                                   |
| ------------- | --------------------------------------------------------------------------------- |
| **優先度**    | P2                                                                                |
| **cook 由来** | wait kind + 加熱待ち                                                              |
| **現状の穴**  | `executor: wait` と Timer / Continuation の関係がドキュメント分散                 |
| **Core 案**   | wait Step の開始で Timer or Continuation を導出する pure helper、状態遷移表の固定 |
| **非目標**    | Provider 固有 resume                                                              |

---

### CE-21 Plan Diff / 要約（表示用）

|               |                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------- |
| **優先度**    | P1                                                                                                |
| **cook 由来** | 改善前後の比較 UX                                                                                 |
| **現状の穴**  | runtime `PlanChange` はあるが、任意の 2 Plan の structural diff が弱い                            |
| **Core 案**   | `diffPlans(a, b) → { addedStepIds, removedStepIds, updatedStepIds, fieldChanges, durationDelta }` |
| **非目標**    | ピクセル diff、UI アニメ                                                                          |

Improve と Replan の両方の UI が同じ diff を使える。

---

### CE-22 計画制約（Constraints）オブジェクト

|               |                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| **優先度**    | P2                                                                                                           |
| **cook 由来** | planning settings / constraints 配列                                                                         |
| **現状の穴**  | Domain planning に instructions はあるが構造化制約がない                                                     |
| **Core 案**   | `PlanningConstraints { maxDurationSeconds?, hardResourceIds?, softNotes?, extras?: Json }` を Planner 入力に |
| **非目標**    | 制約ソルバ本体（CE-05 が消費する入力）                                                                       |

---

### CE-23 Provenance（計画が何から来たか）

|               |                                                            |
| ------------- | ---------------------------------------------------------- |
| **優先度**    | P2                                                         |
| **cook 由来** | recipeSourceId, fetchedFrom                                |
| **現状の穴**  | Raw Input / R2 はあるが Plan Step とのリンクが弱い         |
| **Core 案**   | Step or Plan metadata: `sourceRefs?: { type, id, uri? }[]` |
| **非目標**    | クローラ                                                   |

---

### CE-24 Domain Contract 拡張: planning I/O schemas

|               |                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **優先度**    | P1                                                                                                                                               |
| **cook 由来** | planner output schema と Domain の密結合                                                                                                         |
| **現状の穴**  | `defineDomain` は instructions 中心で、Planner 出力 = ExecutionPlan への写像が暗黙                                                               |
| **Core 案**   | Domain に `planning: { instructions, objectives, planStepExtrasSchema? }` や `toExecutionPlan(normalized, llmOutput)` フックを **optional** 追加 |
| **非目標**    | Domain に LLM client を持たせる                                                                                                                  |

---

## レイヤ別の置き場（再掲）

```text
@pear-agent/core
  CE-01..07, 11..12, 14..18, 21 の型・検証・純関数
  CE-08, 09, 18 の Port 型

@pear-agent/cloudflare
  PlanRepository, PlanGenerator 実装, AI SDK, D1 履歴

@pear-agent/react
  Plan presentation の描画、improve UI、timeline コンポーネント

Domain (outing / cooking)
  kind, materials 中身, prompts, 安全ルール, 正規化

Application (create-pear-agent sample)
  画面遷移: 入力 → 生成 → プレビュー → 編集 → 実行
```

---

## 推奨ロードマップ（Core のみ）

### Wave A — 読める・話せる Plan（P0）

1. CE-01 表示フィールド
2. CE-02 Timer 定義
3. CE-07 title/metadata
4. CE-06 presentation 純関数
5. CE-08 Planner Port を Core へ移動・共有

### Wave B — 作れる・直せる Plan（P1）

6. CE-04 timeline
7. CE-03 / CE-16 量付き資源 + capacity
8. CE-05 scheduler
9. CE-09 improver
10. CE-11 / CE-12 artifact + version
11. CE-21 diff
12. CE-17 / CE-18 goal 整合と評価

### Wave C — cook 本格接続（P2）

13. CE-14 material links
14. CE-10 generation stream 型
15. CE-13 編集 op 橋渡し
16. CE-15 tags
17. CE-19 assignment
18. CE-20 wait 統合
19. CE-22 constraints
20. CE-23 provenance
21. CE-24 Domain planning フック

Wave C の後に **PEAR Cook**（Issue #11 相当）を Domain として接続する。

---

## 既存機能との関係（重複を作らない）

| 既にあるもの                              | 拡張時の扱い                      |
| ----------------------------------------- | --------------------------------- |
| `ExecutionPlan` DAG / `validatePlanGraph` | 維持。timeline は optional        |
| `PlanPatch` + replan activation           | **実行中**の正。improve は実行前  |
| `WorldState`                              | capacity / materials の実行時実体 |
| `defineDomain().planning`                 | CE-08/24 の入力                   |
| Cloudflare `PlanGenerator`                | CE-08 の実装を移す or 再 export   |
| Snapshot / Continuation / Voice           | 変更しない（実行レイヤ）          |

---

## 成功条件（Core 拡張が足りた状態）

次が **料理 Domain なし**でも可能になること。

1. Domain が instructions + schema を渡し、host Planner が `ExecutionPlan` を返す
2. Plan に label/instructions/timer/timeline があり presentation 純関数でレーン表示できる
3. 資源 quantity と capacity で衝突を検出または再配置できる
4. ユーザー改善リクエストで新 Version を保存し diff を取れる
5. その Plan Version から Execution Session を開始し、既存の並行実行・部分 Replan・Continuation が動く

料理固有のレシピ抽出・人数調整は **それでも Domain** のままである。

---

## 関連ドキュメント

- [cook-agent-mapping.md](./cook-agent-mapping.md) — 概念対応と「Core に入れないもの」
- [domain-contract.md](./domain-contract.md) — Domain の責務
- [requirements.md](./requirements.md) — FR-02 Plan, FR-12 Planner
- [state-model.md](./state-model.md) — Session / Snapshot
- [implementation-roadmap.md](./implementation-roadmap.md) — 全体マイルストーン
- [roadmap.md](./roadmap.md) — Phase 5 PEAR Cook 接続

## 改訂履歴

| 日付       | 内容                                            |
| ---------- | ----------------------------------------------- |
| 2026-07-12 | 初版。cook-agent 比較に基づく Core 拡張カタログ |
