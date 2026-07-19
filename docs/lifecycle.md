# PEAR Runtime Lifecycle

## Plan Artifact

```text
draft -> compiling -> awaiting_clarification -> compiling -> review -> ready
  |          |                                      |          |
  |          +-> failed -> retry -------------------+          +-> archived
  +-> cancelled                                               stale
```

Compile jobとPlan Artifactのstatusは分離します。Source変更は既存interpretationとPlanを
`stale`にし、再compileまたは差分編集を要求します。失敗・cancelされた中間artifactは
inspect/retryのため保持します。

## Compile

```text
ingest -> interpret -> clarify? -> synthesize -> validate -> reconcile? -> review
```

重大な不足・矛盾だけclarificationを要求します。回答待ちは標準7日です。
初回Planは自動でreadyにならず、Review後の明示操作を必要とします。

## Draft edit

```text
natural-language request -> AI Patch/full draft -> validate -> diff -> confirm -> new version
```

全体再生成はExecution Session開始前だけ許可します。競合するbase versionは拒否し、
最新Planを使って再提案します。

## Execution Session

```text
not_started -> active -> paused -> active -> completed
       +-------------------------------------> cancelled
```

Ready Plan versionを開始時にforkします。Voice Session切断はExecution Sessionを停止しません。

## Replan

```text
Domain observation/event -> Assess -> affected subgraph -> Patch proposal
  -> diff + confirmation -> validation -> atomic activation -> execute
```

標準modeは`confirm`です。完了済みStepは変更不可、active Step変更はpauseが必要です。
検証失敗時は旧Planを維持して`replan_failed`を記録します。

## Voice Session

```text
disconnected -> connecting -> connected <-> muted
connected -> recovering -> connected
connected -> disconnected
```

生音声と全文transcriptは標準保存せず、状態変更に使った構造化summaryだけEventに残します。
