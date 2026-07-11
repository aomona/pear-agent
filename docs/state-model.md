# 状態モデル

## 3つのライフサイクル

### Execution Session

現実の作業を表します。

```text
not_started → active → paused → active → completed
                         └────────────→ cancelled
```

### Voice Session

音声Providerとの接続を表します。

```text
disconnected → connecting → connected
connected ↔ muted
connected → recovering → connected
connected → disconnected
```

### Continuation

中断後に再開する条件と進行を表します。

```text
none → suspended → wake_pending → resuming → completed
                                      └────→ expired
```

## 状態の組み合わせ例

```text
加熱待ち:
Execution Session: active
Voice Session: disconnected
Continuation: suspended
Timer: running
```

## Runtime Snapshot

再開時に参照する正式な状態です。

```ts
type RuntimeSnapshot = {
  session: ExecutionSession;
  planVersion: PlanVersion;
  stepStates: Record<string, StepState>;
  activeTimers: ExecutionTimer[];
  recentEvents: RuntimeEvent[];
  continuation: ExecutionContinuation | null;
  generatedAt: string;
};
```

Voice Providerの会話履歴はSnapshotの代替ではありません。
