# PEAR Runtime Lifecycle

## Execution Session

```text
not_started → active → paused → active → completed
       └──────────────────────────────→ cancelled
```

SessionのVoice接続が切れてもExecution Sessionは継続できます。

Issue #3のCoreはSession、WorldState、Runtime Event、Timer、materialized state、Snapshot、Repository Portまでを定義します。Event追加と状態更新のatomic性および冪等性はPortの契約です。Cloudflare/D1へ永続化するAdapterはIssue #4の範囲です。

## Step

```text
blocked → ready → active → completed
                    ├────→ paused → active
                    ├────→ failed
                    └────→ skipped
```

- 依存Stepが未完了なら`blocked`
- 依存関係とResource条件を満たすと`ready`
- 複数Stepを同時に`active`にできる
- 完了済みStepはPlan Patchで変更できない

## Voice Session

```text
disconnected → connecting → connected
connected ↔ muted
connected → recovering → connected
connected → disconnected
```

- Execution Sessionごとに同時接続は1つ
- Voice Leaseを取得したActorだけが接続できる
- Provider resume handleは補助情報として永続化する

## Continuation

```text
none → suspended → wake_pending → resuming → completed
                                      └────→ expired
```

### Suspend

```text
suspend要求
→ Snapshot取得
→ Continuation保存
→ Event追加
→ Wake登録
→ Voice切断
```

### Resume

```text
Wake条件成立
→ wake_pending
→ Reactへ同期
→ ユーザーが再開
→ resumingをatomicに取得
→ Gemini Live接続
→ Snapshot再同期
→ completed
```

## PEAR Loop

```text
Goal + Normalized Input + WorldState
                  ↓
                Plan
                  ↓
               Execute
                  ↓
          Event / Observation
                  ↓
               Assess
                  ↓
          Replanが必要か？
             │          │
            No         Yes
             │          ↓
             │   Impact Analysis
             │          ↓
             │     Plan Patch
             │          ↓
             └─────→ Execute
```

## Replan

```text
Eventを記録
→ WorldState更新
→ Affected Subgraph特定
→ Patch生成
→ Schema検証
→ DAG検証
→ Policy検証
→ 新Plan Version保存
→ atomicに有効化
→ Step State再計算
→ 音声とUIで説明
```

検証に失敗した場合は旧Planを維持し、`replan_failed`イベントを追加します。

## Goal Completion

成功条件は人間、Tool、状態ルール、AIのいずれかで評価します。全条件を満たした場合、Completion Policyに従って自動完了または人間確認へ進みます。
