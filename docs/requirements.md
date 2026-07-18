# PEAR Runtime v0.1 要件定義

## 1. プロダクト概要

PEAR Runtimeは、複数の非構造SourceをLLMで検証可能なExecution Planへcompileし、
自然言語で編集し、Realtime AIとdurableに実行・再計画するTypeScript OSS Runtimeです。

```text
Sources -> Interpret -> Clarify -> Plan -> Review -> Execute -> Assess -> Replan
```

## 2. 対象と提供形態

- 対象はPEARで実行支援アプリを作るTypeScript開発者
- npm packageと`create-pear-agent`で提供
- 公式durable adapterはCloudflare-first
- データ、認証、API keyはhost applicationが所有
- React/browserを公式client、Geminiを公式AI providerとする

## 3. Packages

- `@pear-agent/core`: schemas、ports、pure reducers、validation、diff
- `@pear-agent/ai`: Vercel AI SDKのprovider-neutral implementations
- `@pear-agent/cloudflare`: Workers、Workflows、Agents/DO、D1、R2、HTTP
- `@pear-agent/react`: typed clientとhooks
- `create-pear-agent`: AI-first starterとexplicit examples

## 4. 機能要件

### FR-01 Source ingestion

- text、公開HTTP(S) URL、PDF/plain text/Markdown/JSON fileを受け付ける
- Raw bytesと抽出本文をR2、metadata/checksumをD1へ保存する
- URL取得はSSRF、redirect、size、content-typeを検証する
- Source変更は下流artifactをstaleにする

### FR-02 Durable compile

- ingest、interpret、clarify、synthesize、validate/reconcileをdurable jobとして実行する
- phase/statusを購読でき、HTTP pollingへfallbackできる
- cancel、bounded retry、失敗phaseからのretryを提供する
- clarification待ちは標準7日
- 失敗・cancelされた中間artifactをinspect/retryできる

### FR-03 AI interpretation

- DomainのinstructionsとSchemaからNormalized Domain Modelを生成する
- 重大な不足・矛盾はclarification、軽微な推測はassumptionとして返す
- Source、抽出結果、Normalized Model、generation metadataを追跡する

### FR-04 Plan synthesis

- PlanはStep DAG、時間、resource、timer、Domain Dataを表現する
- AIが候補を生成し、RuntimeがID、Schema、DAG、Domain invariantを確定する
- Domain validatorを必須、safe reconcilerを任意とする
- 各StepからSourceへprovenanceを追跡できる

### FR-05 Review and editing

- 初回Planはdraftで、明示Review後にreadyとなる
- 自然言語編集はfull draftまたはPlanPatchを提案し、diff確認後に適用する
- 全体再生成は実行前だけ許可する
- stale baseへの編集は拒否し、最新versionで再提案する

### FR-06 Execution

- Ready Plan versionからExecution Sessionをforkする
- SessionはPlan、WorldState、Step States、Events、Timers、Continuationをdurableに保持する
- Session変更を元Artifactへ自動反映しない
- 最終Planを明示的に`Save as Plan`できる

### FR-07 Replan

- Goal、Plan、WorldState、Events、Normalized InputをAssessへ渡す
- affected subgraphだけをPatchする
- 標準modeは`confirm`
- completed/skipped Step変更を禁止する
- active Step変更はpauseと人間確認を必須にする
- PatchのSchema、DAG、Policy、Domain invariantを検証し、atomicにactivateする

### FR-08 AI SDK

- Vercel AI SDKのstructured outputをInterpret/Plan/Edit/Replanへ使用する
- Geminiを公式E2E provider、他providerは`LanguageModel`注入可能とする
- stage別model override、call/token/time budget、bounded retryを提供する
- AI失敗時に暗黙のdeterministic fallbackを行わない

### FR-09 Realtime

- Gemini Liveとephemeral tokenを公式実装とする
- Voice SessionはExecution Sessionから独立した一時接続とする
- 低riskかつ高confidenceなEventだけ自動記録できる
- Patch適用と外部Capabilityはconfirmationを必要とする
- 生音声と全文transcriptを標準保存せず、構造化された判定根拠だけ保存する

### FR-10 Provenance and observability

- RuntimeがArtifact、Job、Patch、Stepの永続IDを割り当てる
- Changeはsource、user instruction、clarification、runtime eventのtyped cause refsを持つ
- provider/model、prompt/schema version、usage、validation/warningsを保存する
- 生prompt/raw responseは標準保存しない
- Artifact Inspectorからphase、provenance、validation、diff、versionを確認できる

### FR-11 React and CLI

- ReactはUIを固定せずtyped client/hooksを提供する
- Starterは`Sources -> Compile -> Review -> Execute`を実演する
- v0.1のCLIはMinimal Starterをデフォルト生成し、`--example outing`のみ互換サンプルとして提供する
- Cook / Presentation など本格 Reference は v0.1 外（別途）
- API key未設定時は明示setup errorを返す

### FR-12 Authorization

- 認証はhost責務
- Runtimeはactor/roles/claimsと操作単位authorize hookを受け取る
- 未認可操作はR2/D1/AIへwrite/callしない

## 5. 非機能要件

- CoreはCloudflare、React、AI SDK、Geminiへ依存しない
- Event appendとmaterialized state更新はatomicかつidempotent
- 通常CIはAI fixture、実Geminiはmanual/scheduled smokeで検証する
- WCAG 2.2 AA、responsive、keyboard、reduced motionを公式UI要件とする
- pre-push gateはtypecheck、lint、format check、testの4つ

## 6. Defaults

- text/HTML 2 MiB、text document 5 MiB、PDF 50 MiB/1000 pages、20 Sources/job
- AIは各phase最大3 attempts、12 calls/job、100万tokens/job、5分/call
- Replanは`confirm`、Realtime自動Event閾値はconfidence 0.8
- Artifactはhostが削除するまで保持し、削除は参照安全なcascade

## 7. v0.1非目標

- PPTX/Google Slides connector
- 画像、音声、動画のcompile source
- Gemini Live以外のRealtime provider保証
- Node durable adapter
- Hosted control plane、組み込みauth/tenant/key管理
- 自動provider/deterministic fallback
- Cook / Presentation など Domain 専用 Reference Application 本体
- Cookのスマート家電Capability

## 8. v0.1 完成条件

Minimal Starter（または同等の host app）で次を完走できること。

```text
Sources → AI Compile → Clarify? → Review → NL Edit → Execute
```

- Source 入力（text / URL / file）と durable CompileJob
- AI 構造化・Plan 生成・clarification・自然言語 edit proposal
- Execution Session でのステップ進行
- Artifact Inspector から sources / jobs / generations / provenance を追跡
- ローカル pre-push gate（typecheck / lint / format / test）が緑

Cook / Presentation の E2E は v0.1 の完成条件に含めない。
