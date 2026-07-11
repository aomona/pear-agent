# PEAR Runtime v0.1 要件定義

## 1. プロダクト概要

PEAR Runtimeは、開発者が自身のCloudflare環境へデプロイし、現実作業をハンズフリーで支援するリアルタイム音声エージェントをTypeScriptで構築するためのOSSランタイムです。

PEAR Loopを実行モデルとします。

```text
Plan → Execute → Assess → Replan
  ↑                         │
  └─────────────────────────┘
```

## 2. 対象ユーザーと提供形態

対象ユーザーは、PEAR Runtimeを使って独自の実行支援アプリケーションを作る開発者です。

- MITライセンスで公開する
- npmから利用できるTypeScriptライブラリとして提供する
- 開発者自身のCloudflareアカウントへデプロイする
- PEAR側は利用者のデータやAPIキーを預からない
- WebブラウザとReactをv0.1の公式クライアントとする

## 3. v0.1の提供物

```text
@pear-agent/core
@pear-agent/cloudflare
@pear-agent/react
create-pear-agent
```

### `@pear-agent/core`

CloudflareやReactへ依存しない実行モデル、状態遷移、検証ロジックを提供します。

Issue #3ではExecution Session、WorldState、Runtime Event、Timer、materialized state、Snapshot、冪等かつatomicな更新を表すRepository Portとin-memory参照実装までをCoreに実装しました。Cloudflare/D1の永続Repository実装は含まず、Issue #4でAdapterとして実装します。

### `@pear-agent/cloudflare`

Workers、Agents、Durable Objects、D1、R2、WorkflowsへのAdapterを提供します。

### `@pear-agent/react`

UIを固定せず、セッション状態と操作を利用するためのReact hooksを提供します。

### `create-pear-agent`

外出準備サンプルを含む、デプロイ可能なプロジェクトを生成します。

## 4. 開発者の責任範囲

開発者は次を実装します。

- Domain定義
- 入力Schemaと正規化処理
- Domain固有データSchema
- Planner / Replannerへの指示
- Domain固有イベント
- Capability
- 認証処理
- フロントエンド

PEAR Runtimeは次を提供します。

- Goalと成功条件
- DAG形式のExecution Plan
- Execution Sessionと複数Actor
- WorldStateとRuntime Event
- Step状態遷移と並行実行
- Capability Policy
- Timer、Continuation、Wake
- Realtime Voice Session
- Assessと部分再計画
- Plan Patch、Version、Rollback
- 永続化とリアルタイム状態同期

## 5. 機能要件

### FR-01 Goal

- Execution SessionはGoalを必須で持つ
- Goalは説明と1件以上の成功条件を持つ
- 期限と優先度は任意とする
- 成功条件は人間確認、Tool結果、状態ルール、AI評価で判定できる
- Completion Policyは`automatic`または`human_confirmation`とする

### FR-02 Execution Plan

- PlanはStepのDAGとして表現する
- Stepは依存関係、所要時間、必要リソース、Timer、Domain Dataを持つ
- 複数Stepを同時に`active`にできる
- 循環依存と存在しないStep参照を拒否する
- PlanはVersion管理し、以前のVersionへ戻せる

### FR-03 Step Executor

Stepの実行主体は次のいずれかとします。

- `human`
- `agent`：Capabilityを指定する
- `wait`：Wake Conditionを指定する

### FR-04 Actor

- Execution Sessionは複数Actorを持てる
- Actorは`human`、`agent`、`system`のいずれかとする
- Stepへ1人以上のActorを割り当てられる
- Eventは`actorId`と発生元を記録する
- 共同編集UIはv0.1の対象外とする

### FR-05 CapabilityとPolicy

Capabilityごとに次を設定できます。

- 入力Schema
- Risk Level
- 実行Mode：`automatic`、`confirm`、`suggest`

LLMのTool Callは直接状態を変更せず、Runtimeが認可とPolicyを評価してから実行します。

### FR-06 WorldStateとEvent

- Planとは独立したWorldStateを持つ
- WorldStateはfacts、resources、observations、active constraintsを表現する
- Runtime Eventを監査履歴として追記する
- 最新WorldStateとStep Stateはmaterialized stateとして保持する
- 状態更新とEvent追加は同一トランザクションで行う
- v0.1ではEvent Logだけから全状態を再構築できることを要件としない

### FR-07 InputとProvenance

- Raw Inputは形式やサイズに関係なくR2へ保存する
- Raw Inputのmetadata、checksum、object keyをD1へ保存する
- Domainの`normalizeInput()`が型付きNormalized Inputを生成する
- Normalized InputをD1へ保存する
- PlannerとReplannerは通常、Normalized Inputのみを使用する
- 情報不足や根拠確認時のみRaw Inputを読み出す
- Plan StepとPlan Patchから入力と原因Eventを追跡できる

### FR-08 Realtime Voice

- Realtime Voiceはv0.1の必須機能とする
- Gemini Liveをv0.1の必須Providerとする
- AI SDKはPlan、Assess、Replanへ使用する
- Realtime Voiceは`@google/genai`で実装する
- PEAR独自の薄いVoice Provider契約を定義する
- v0.1では他Providerとの互換性を保証しない
- Execution Sessionごとに同時接続可能なVoice Sessionは1つとする
- Voice Leaseにより接続権を管理する
- Voice Sessionの切断はExecution Sessionの停止を意味しない

### FR-09 音声データ

- 生音声と音声レスポンスはデフォルトで保存しない
- 文字起こし、Tool Call、状態変更はEventとして保存する
- 文字起こしの保存はDomain設定で無効化できる
- 保持期間をDomainまたはアプリ設定で指定できる

### FR-10 Continuation

- 中断時に最新Runtime Snapshot、理由、Wake Condition、Resume Directiveを保存する
- Wake Conditionは`manual`、`time`、`event`を表現できる
- 時刻指定WakeはCloudflare AgentsのSchedulerを基本とする
- 複数段階の長時間処理はWorkflowsを使用する
- Wake後は`wake_pending`をクライアントへ同期する
- v0.1ではユーザー操作後にVoice Sessionを再接続する
- Provider resume handleがなくてもSnapshotから再開できる
- 二重再開をatomicな状態遷移で防止する

### FR-11 Assessと部分再計画

- Goal、Plan、WorldState、Recent EventsをAssessの入力にする
- Eventから影響を受けるSubgraphを特定する
- 影響範囲だけをPlan Patchとして生成する
- Replan Modeは`automatic`、`confirm`、`suggest`から設定できる
- v0.1の標準Modeは`automatic`とする
- 完了済みStepの変更と削除を禁止する
- 実行中Stepは原則変更しない
- 実行中Stepの変更には中断と人間確認を必要とする
- Patch適用前にSchema、DAG、Policy、WorldStateとの整合性を検証する
- Patch適用後にStep Stateとリソース利用状況を再計算する
- 変更理由、原因Event、変更差分を保存して音声とUIで説明する

### FR-12 Planner

- 開発者はSchema、instructions、objectivesを宣言する
- PEAR RuntimeがAI SDKを使ってPlannerとReplannerを構築する
- AI出力はすべてSchema検証する
- 特殊用途向けの低レベルPlanner差し替えは将来の拡張点とし、v0.1の公開互換性を保証しない

### FR-13 認証と認可

- 認証はホストアプリの責任とする
- Runtimeは`actorId`、roles、claimsを受け取る
- 開発者定義の認可Hookを各操作前に呼び出す
- 特定のOAuthや認証ライブラリへ依存しない

### FR-14 React hooks

最低限、次のhooksを提供します。

- `useExecutionSession`
- `useRuntimeSnapshot`
- `useContinuation`
- `useVoiceSession`

hooksはリアルタイム同期、再接続、Loading、Error状態を扱います。UIコンポーネントは強制しません。

### FR-15 CLI

次の操作でサンプルを生成・実行・デプロイできることを目標とします。

```bash
pnpm create pear-agent my-agent
cd my-agent
pnpm dev
pnpm deploy
```

生成物にはCloudflare設定、外出準備Domain、React UI、Gemini Live接続、環境変数例、最小テストを含めます。

### FR-16 Devtools

読み取り専用の簡易Devtoolsを提供します。

- Goalと成功条件
- Plan DAGとVersion
- Step状態
- WorldState
- Event Timeline
- TimerとContinuation
- Plan Patchの差分
- Voice Tool Call
- エラーと再試行

## 6. 非機能要件

### NFR-01 性能目標

| 操作 | 開発時の目標 |
| --- | ---: |
| Runtime Tool Call | 1秒以内 |
| Reactへの状態同期 | 1秒以内 |
| Voice Session再接続 | 3秒以内 |
| 再開後の最初の案内 | 5秒以内 |
| 部分再計画 | 10秒以内 |

外部モデルやネットワークへ依存するため、サービス保証値ではなく開発時の目標とします。

### NFR-02 信頼性

- 再計画に失敗した場合は旧Planを維持する
- `replan_failed`イベントと失敗理由を保存する
- 再試行または人間判断へ切り替えられる
- Voice切断時はSnapshotから再接続できる
- Provider handle失効時は新規Voice SessionへFallbackする
- 状態変更は冪等性キーとatomic updateで二重実行を防ぐ

### NFR-03 セキュリティ

- APIキーをクライアントへ直接配布しない
- Gemini Liveのクライアント接続には短命な認証情報を使う
- Raw Inputは任意のPlanner Toolから直接列挙できない
- すべての操作で認可Hookを適用する
- 機密値をEvent、Transcript、Devtoolsへ出力しない

### NFR-04 ポータビリティ

- CoreはWeb標準APIとTypeScriptで表現する
- Cloudflare固有APIはAdapterへ閉じ込める
- v0.1はCloudflare-firstとし、他環境へのデプロイは公式対応しない

### NFR-05 テスト

- Coreの状態遷移、DAG、Policy、Patchを単体テストする
- Cloudflare AdapterをWorkers統合テストで検証する
- React hooksの接続と再接続を検証する
- Gemini LiveはFake Voice Providerで自動テストする
- 実Providerを使う手動スモークテストを用意する
- 外出準備サンプルをPlaywright E2Eで検証する
- デモシナリオ10回中9回以上の完走を目標にする

### NFR-06 開発ツール

- LintはOxlintを唯一の基準とする
- FormatはOxfmtを唯一の基準とする
- Typecheckはtsgoを使用する
- tsgoは`@typescript/native-preview`として導入し、lockfileでVersionを固定する
- tsgoがPreviewであることを既知の制約として明記する
- tsgo固有の不具合で開発が停止する場合に限り、診断比較用としてTypeScript stableを一時実行できるが、CIの正式なTypecheckはtsgoとする

## 7. v0.1の非目標

- Gemini Live以外のVoice Provider対応
- モバイルネイティブSDK
- ブラウザを閉じた状態からの自動音声再生
- 複数の同時Voice Session
- 共同編集UI
- Domain Marketplace
- ノーコードDomain生成
- 任意コードの動的実行
- 純粋なEvent Sourcing
- 完全なProvider互換性

## 8. 2026年8月20日の完成条件

外出準備サンプルで次を実演できることを完成条件とします。

```text
CLIでプロジェクト生成
→ Cloudflareへデプロイ
→ Plan生成
→ 音声で複数Stepを実行
→ 待機中にVoice Sessionを中断
→ Wake後にボタンで再開
→ 最新Snapshotから案内
→ 遅延Eventを報告
→ Affected Subgraphだけを部分再計画
→ Goal達成を判定して完了
```
