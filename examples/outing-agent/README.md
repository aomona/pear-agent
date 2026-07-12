# PEAR Outing Agent (Reference Application)

外出準備サンプル。CLI から生成されるテンプレートの正本です。

## できること

1. **並行準備** — pack と charge を同時に active にできる
2. **Voice Suspend** — 充電待ちで音声だけ中断（Execution Session は継続）
3. **Wake / Resume** — Continuation claim + Snapshot 再同期 + Voice 再接続
4. **部分 Replan** — delay イベント後に charge だけを Plan Patch

UI は **shadcn/ui**（sample app のみ。`@pear-agent/react` は hooks-only）。

## 前提

- monorepo ルートで `pnpm install` 済み
- Node 20+
- 任意: Gemini API キー（Voice 用）

## セットアップ

```bash
# monorepo root
pnpm install

cd examples/outing-agent
cp .dev.vars.example .dev.vars   # GEMINI_API_KEY=... を任意で設定
cp .env.example .env             # 通常はそのまま
```

## 開発

```bash
pnpm dev
```

`pnpm dev` は **predev** でローカル D1 マイグレーション（`migrations/*.sql`）を適用してから Worker + Vite を起動します。  
`no such table: execution_sessions` が出る場合は、まだ schema が無い状態です。次で直せます。

```bash
pnpm db:migrate:local
```

- Worker API: http://127.0.0.1:8787
- Web UI: http://127.0.0.1:5173

ブラウザは `VITE_PEAR_API_BASE`（既定 `http://127.0.0.1:8787`）へ直接呼びます。  
Worker 側で **CORS**（`OPTIONS` 含む）を許可しているので、Vite とポートが分かれていても Create session できます。  
`GET /` の 404 は正常です（API のみ。UI は :5173）。

### Voice 会話（Gemini Live API）

実装は [gemini-live-api-dev](https://github.com/google-gemini/gemini-skills) に準拠:

| 項目      | 内容                                                                     |
| --------- | ------------------------------------------------------------------------ |
| Model     | `gemini-3.1-flash-live-preview`                                          |
| Auth      | Worker が ephemeral token を mint（API key はブラウザに出さない）        |
| Input     | 16 kHz PCM16 mono via `sendRealtimeInput({ audio })`                     |
| Output    | 24 kHz PCM16 mono playback                                               |
| Text      | `sendRealtimeInput({ text })`（会話中は `sendClientContent` を使わない） |
| Mute      | `audioStreamEnd` でサーバ側バッファを flush                              |
| Interrupt | `serverContent.interrupted` で再生キュー破棄                             |

手順:

1. `.dev.vars` に有効な `GEMINI_API_KEY` を設定し Worker を再起動
2. Session 作成後 **Connect voice**（マイク許可を OK）
3. **ヘッドホン推奨**（エコーで自己割り込みを防ぐ）
4. マイクで話す（文字起こしはパネルに表示）

初回応答の体感遅延にはモデル/ネットワーク分が残ります。クライアント側は ~40ms チャンク送信 + 再生キュー上限で積み遅延を抑えています。

## デプロイ

```bash
# Cloudflare にログイン済みであること
# 初回は remote D1 / R2 を作成し wrangler.jsonc の database_id を更新
pnpm db:migrate:remote
pnpm deploy
```

Web は別途 Vite build + Pages/Assets へ載せるか、当面はローカル UI から remote Worker の URL を `VITE_PEAR_API_BASE` に設定します。

## デモ手順

1. **Setup** で持ち物を入力 → Create & start session
2. **Plan & Steps** で pack / charge を Start（並行）
3. **Voice** を Connect → **Suspend (charge wait)**
4. ページをリロード → session id が復元されることを確認
5. **Claim resume** → **Reconnect voice** → **Complete resume**
6. **Report delay** → **Request replan** → charge の duration 差分を確認
7. Steps を Complete

## パッケージ境界

| パス                                | 役割                                                      |
| ----------------------------------- | --------------------------------------------------------- |
| `worker/`                           | `createPearWorker` ホスト                                 |
| `web/`                              | React + shadcn デモ UI                                    |
| D1 migrations                       | `packages/cloudflare/migrations` を参照（二重管理しない） |
| `@pear-agent/outing-domain-example` | Domain / Plan / Replan helpers                            |

## 依存について

`@pear-agent/*` は現時点で monorepo `workspace:*` 専用です。npm 公開前は monorepo 内、または `create-pear-agent --from <repo-root>` の `file:` 解決を使ってください。
