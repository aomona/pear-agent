# アーキテクチャ

## レイヤー

```text
Application / Reference UI
  -> Domain Definition (schemas, instructions, invariants)
  -> PEAR Compile + Execution Ports
  -> @pear-agent/ai (Vercel AI SDK)
  -> @pear-agent/cloudflare (Workflow / Agent / D1 / R2)
  -> Gemini text + Gemini Live
```

`@pear-agent/core`は環境非依存です。Cloudflare、React、AI SDK、Geminiをimportしません。

## Compile data flow

```text
Plan Artifact draft
  -> Source upload/fetch (R2 bytes, D1 metadata)
  -> Compile Workflow
     -> ingest/extract
     -> AI SourceInterpreter
     -> clarification wait when required
     -> AI PlanGenerator
     -> Zod + Domain invariant validation
     -> optional safe reconciliation
  -> reviewed draft Plan version
  -> confirmed ready Plan Artifact
```

`PlanArtifactAgent`はartifact単位のdurable identityと状態broadcastを担当します。
D1が正本であり、WorkflowやAgentのmemoryを正本にしません。

## Execution data flow

```text
Ready Plan Artifact version
  -> fork Execution Session
  -> Gemini Live / UI execution
  -> Runtime Event + WorldState
  -> AI assessment
  -> typed Plan Patch proposal
  -> confirmation + validation
  -> atomic Plan version activation
```

Execution Sessionから元artifactへ変更を自動反映しません。必要な場合だけ最終Planを
`Save as Plan`で明示保存します。

## AI responsibility

AIはSource interpretation、Plan synthesis、自然言語編集、Assess、Patch提案を担当します。
RuntimeはID、schema、DAG、resource、policy、provenance、永続化を担当します。
AIがD1/R2やExecution Stateを直接変更することは禁止します。

## Provider boundary

通常生成はVercel AI SDKの`LanguageModel`を注入します。Geminiを公式検証しますが、
provider固有分岐は`@pear-agent/ai`のcapability検証へ閉じ込めます。
Realtimeは`@google/genai`とephemeral tokenを使い、Gemini Liveをv0.1で保証します。

## Storage

- R2: Raw source bytesと抽出本文
- D1: source metadata、compile jobs、interpretations、clarifications、generation metadata、
  Plan artifacts/versions/changes、Execution Sessions、Events、WorldState、Continuations
- Workflows: durable compile orchestrationとclarification wait/retry
- Agents/DO: Plan ArtifactとExecution Sessionのidentity、mutation serialization、state sync
