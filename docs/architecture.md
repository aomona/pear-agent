# アーキテクチャ

## レイヤー

```text
Application
    ↓
Domain Adapter（Cookingなど）
    ↓
PEAR Runtime（Session / Event / Timer / Continuation）
    ↓
Cloudflare Adapter / AI Provider Adapter
```

## 提供パッケージ

- `@pear-agent/core`
- `@pear-agent/cloudflare`
- `@pear-agent/react`
- `create-pear-agent`

cook-agent 相当の計画体験に向けた **Core 拡張候補**（Step 表示、timeline、scheduler、Planner Port など）は [core-extensions-for-cook-parity.md](./core-extensions-for-cook-parity.md) を参照。

## Cloudflareの責務

- **Workers**：HTTP API、認証、Tool Call、AI SDK呼び出し、D1アクセス
- **Agents**：Execution Session単位のdurable identity、状態、スケジュール
- **D1**：Normalized Input、セッション、Plan、Plan Version、WorldState、Event、Timer、Continuation
- **R2**：すべてのRaw Input
- **Workflows**：複数段階の再計画、長時間処理、リトライ

## AI SDKの責務

構造化されたPlan生成、再計画、情報収集用のTool Calling、評価・差分要約を担当します。
状態の永続化や状態遷移はAI SDKのAgent Loopに任せず、PEAR Runtimeの通常のTypeScript関数で行います。

## Gemini Liveの責務

マイク入力、音声出力、リアルタイム会話、音声Tool Call、Provider resume handleを担当します。
Gemini Liveの接続状態は、Execution Sessionの正式状態ではありません。

## データフロー

```text
ユーザー入力 → Domain Normalizer → AI SDK Planner → Plan Version
→ Execution Session → Voice / UIによる実行支援
→ Runtime Event + Timer → Assess → AI SDK Replanner → 新Plan Version
```

## Cloudflare依存の境界

PEAR Runtimeの中心型はWeb標準APIとTypeScriptだけで表現し、Cloudflare固有APIはAdapterへ閉じ込めます。当面はCloudflare-firstで実装しますが、CoreからCloudflare APIを直接参照しません。

Realtime Voiceはv0.1の必須機能です。Gemini Liveを標準Providerとし、AI SDKはPlan、Assess、Replanへ使用します。
