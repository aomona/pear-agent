# PEAR Runtime Distribution Contract

## 目的

PEAR Runtimeの配布物を、製品本体、編集可能なStarter、Reference Application、導入ガイドに分離します。完成デモをそのまま新規プロジェクトへ複製せず、開発者が自分のDomainとUIへ置き換える範囲を明確にします。

## 配布レイヤー

| レイヤー              | 役割                                                         | 開発者が編集するか |
| --------------------- | ------------------------------------------------------------ | ------------------ |
| Runtime packages      | Core、Cloudflare Adapter、React hooks                        | 通常は編集しない   |
| Minimal Starter       | 実行可能なCloudflare + Reactプロジェクトの最小構成           | 編集する           |
| Reference Application | PEAR Loop全体を説明・検証する具体的なDomainアプリケーション  | 参考にする         |
| Skills / Documents    | 既存アプリへの導入、Domain作成、UI変更、デプロイの作業ガイド | 適用する           |

Runtimeの正式な公開面は`@pear-agent/core`、`@pear-agent/cloudflare`、`@pear-agent/react`です。`create-pear-agent`はこれらを利用するプロジェクトを生成しますが、デフォルトのMinimal Starter生成ではRuntime実装やReference Applicationを複製元にはしません。

## CLI契約

### Minimal Starter

```bash
pnpm create pear-agent my-agent
cd my-agent
pnpm dev
pnpm deploy
```

デフォルトでは、特定の実世界Domainに依存しないMinimal Starterを生成します。

- Cloudflare Worker / Agent / D1 / R2設定
- PEAR Providerを接続したReactアプリ
- 一覧、入力、計画、実行の4ページ
- 環境変数例と最小テスト
- DomainとPlannerの差し替え口

主な編集箇所は次の3領域に限定します。

```text
src/
├── app/pages/       # 一覧、入力、計画、実行
├── domain/          # Schema、正規化、Planner / Replanner、Domain Event
└── pear.config.ts   # Provider、認可、機能設定
```

Voice、Continuation、Timer、ReplanなどのRuntime配線は、通常のアプリ変更で触れる必要がない場所へ閉じ込めます。`@pear-agent/react`は引き続きhooks-onlyとし、固定UIコンポーネントを公開しません。

### Optional Reference Example

```bash
pnpm create pear-agent my-agent --example outing
```

OutingはPEAR Loopを端から端まで実演するReference Applicationです。

- 並行準備
- Voice Suspend
- Wake / Snapshot Resume
- 遅延Eventによる部分Replan
- Plan Patch差分

Outingのソースは`examples/outing-agent`に置き、Minimal Starterの正本や暗黙のデフォルトにはしません。CLIから生成する場合は、明示的な`--example outing`を必要とします。

## Skills / Documents契約

Skillsと文書を、既存プロジェクトへPEARを導入する主経路にします。最低限、次の作業を個別に案内できる状態を目標とします。

- RuntimeとCloudflare bindingsの初期化
- Domain SchemaとPlanner / Replannerの作成
- Reactの4ページフローへの接続
- Voice、Continuation、Replanの追加
- ローカル実行、検証、Cloudflareデプロイ

SkillsはRuntimeの制約と編集対象を説明し、必要なファイルだけを生成・変更します。固定された完成アプリを貼り付ける代替手段にはしません。

## Source of Truth

- Runtime契約: `packages/core`、`packages/cloudflare`、`packages/react`
- Minimal Starter: `create-pear-agent`が所有するpackage内template
- Outing Reference Application: `examples/outing-agent`
- Domain例: `examples/outing-domain`
- 配布要件: この文書と`docs/requirements.md` FR-15

Minimal StarterとOutingはコピー元を共有しません。Reference ApplicationのUI変更が、生成されるMinimal Starterへ暗黙に流入しない構造にします。

## v0.1の非目標

- Domain Marketplace
- 複数のStarterを選ぶtemplate catalog
- ノーコードDomain生成
- PEAR固有UI component library
- 任意の既存フレームワークを自動変換する汎用initializer

既存プロジェクトへの自動`init` CLIは将来拡張とし、v0.1ではSkills / Documentsによる明示的な導入手順を優先します。

## 移行順序

1. 要件とIssue #9をMinimal Starter / optional Outing契約へ更新する
2. `create-pear-agent` package内にMinimal Starterの正本を作る
3. CLIのデフォルトをMinimal Starterへ切り替える
4. `--example outing`を追加する
5. Skills / Documentsとgreenfield生成のsmoke testを整備する

移行完了までは現行CLIが`examples/outing-agent`をコピーします。契約変更と実装変更を別PRにし、各PRで現在の挙動を壊さないように進めます。
