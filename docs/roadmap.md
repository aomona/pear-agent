# ロードマップ

## Phase 0：定義

- PEAR Agent / PEAR Loopの定義を固定する
- 既存cook-agentとの関係を記録する
- 中断・再開デモの受け入れ条件を決める

## Phase 1：最小Runtime

- Goal / Success Criteria
- Execution Session
- Actor / Capability / Policy
- DAGと並行Step
- WorldState
- Runtime Event
- Runtime Snapshot
- Timer
- Continuation
- Cloudflare Agentsの基本接続

## Phase 2：中断・再開

- 手動中断
- 時刻指定Wake
- ページ再読み込み後の復元
- atomicな再開
- Snapshot再同期
- Gemini Live接続の再作成

## Phase 3：外出準備の縦切り

- CLIとサンプル生成
- 外出準備Domainの入力とPlan生成
- 音声による工程案内
- 遅延イベント
- Affected Subgraphの部分再計画と差分表示
- 3〜5分の通しデモ

## Phase 4：安定化

- 再接続失敗時の復旧
- handle失効時のFallback
- 二重Tool Call対策
- E2Eテスト
- 設計判断と既知の制限の文書化

## Phase 5：PEAR Cook接続

cook-agentの知見をCooking Domainへ移し、外出準備と同じRuntime、Continuation、Voice Provider、React hooksを利用できることを確認します。

## 将来候補

- イベント待機の強化
- 部分再計画とPlan Patch
- 複数人セッション
- Push通知
- カメラ・センサーによるAssess
- GitHubやCalendarなどのCapability Provider
- Domain実装ガイドをSkillsとして整備
