# PEAR Agent 🍐

**Plan, Execute, Assess, Replan.**

PEAR Agentは、現実の作業をAIと一緒に最後まで進めるための実行支援エージェントです。PEAR Runtimeは、開発者がこの体験を持つアプリを自身のCloudflare環境へ構築するためのTypeScriptランタイムです。

> 計画を作るだけではなく、終わるまで組み直すAI。

## PEAR Loop

```text
Plan → Execute → Assess → Replan
  ↑                         │
  └─────────────────────────┘
```

- **Plan** — 目標・制約・リソースから計画を生成
- **Execute** — 人間の実行を音声・UIで支援
- **Assess** — 完了、遅延、失敗、リソース不足を記録
- **Replan** — 最新状態から残りの計画を更新

## 解決する課題

現実の作業は、最初に作った手順どおりには進みません。PEAR Agentは計画と実行状態を永続化し、音声接続が中断しても作業セッションを失わないことを重視します。

音声接続は状態の正ではありません。中断後は、保存されたExecution Sessionの最新スナップショットに新しい音声セッションを接続し直します。

## Reference Applications

最初の縦切りは、CLIから生成できる外出準備サンプルです。中断、Wake、音声再開、部分再計画までを小さなDomainで実証します。

複数料理を同時に完成させる **PEAR Cook** は、cook-agentの知見を引き継ぐ第二のReference Applicationです。

- 複数レシピの統合計画
- 人数、器具、時間の制約を考慮した計画
- 音声による工程案内
- 遅延や材料不足の記録
- 状況変化を反映したリアルタイム再計画
- 待機中の音声セッション中断と再開

料理固有の機能を基盤へ埋め込まず、PEAR CookをPEAR Runtimeの汎用性を検証する用途として扱います。

## アーキテクチャ

```text
Browser
├─ React UI
├─ Microphone / Audio playback
└─ Gemini Live（音声セッション）
          │
          ▼
Cloudflare Workers
├─ PEAR Agent API
├─ AI SDK（計画・再計画・構造化出力）
├─ Execution Session API
└─ Runtime Tool Call
          │
          ├─ Cloudflare Agents（セッション状態・スケジュール）
          ├─ D1（一覧・永続データ）
          └─ Workflows（長時間処理）
```

## 技術スタック

- TypeScript
- React + Vite
- Hono on Cloudflare Workers
- Cloudflare Agents / Durable Objects
- Cloudflare D1 / Workflows
- Vercel AI SDK（Planner / Replanner / Tool Calling）
- Gemini Live API（Realtime Voice）
- Zod
- Vitest / Playwright

AI SDKはモデル呼び出し、構造化出力、Tool Callingを担当します。Gemini Liveは連続音声のWebSocketセッションとして分離します。

## 状態の基本モデル

| 状態 | 役割 |
| --- | --- |
| Execution Session | 現実の作業そのものの進行状態 |
| Voice Session | 音声モデルとの一時的な接続 |
| Continuation | 中断後に再開するための予約状態 |

加熱待ちの例：`Execution Session: active`、`Voice Session: disconnected`、`Continuation: suspended`、`Timer: running`。

## v0.1の範囲

### 実装するもの

- 複数Actorを持てるExecution Session
- 複数Stepの並行実行
- 手動中断と時刻指定による中断
- Continuationの永続化
- Cloudflare上のWake処理
- ページ再読み込み後の状態復元
- 最新Runtime Snapshotからの音声再開
- 影響範囲だけを更新する部分再計画
- 外出準備サンプルによる計画・実行・再計画デモ
- React hooks、CLI、簡易Devtools

### 初期対象外

- ブラウザを閉じた状態での自動マイク起動
- 共同編集UI
- 複数Voice Providerへの対応
- Domain Marketplaceやノーコード作成機能
- 長時間・大規模Plan向けの高度な最適化

## 開発方針

1. Execution SessionをVoice Sessionから分離する
2. D1やAgent Stateを作業状態の正とする
3. Providerの会話履歴やresume handleは補助情報として扱う
4. LLMに状態遷移を任せず、RuntimeのToolを通して変更する
5. 料理固有の概念はDomain側へ閉じ込める
6. まず中断・再開・再計画の一連のデモを完成させる

詳細仕様は[要件定義](./docs/requirements.md)と[`docs/`](./docs/)を参照してください。

> **AIが計画と実行を支援し、現実の変化を評価して、実行中に計画を更新する閉ループ型の実行支援基盤。**
