# 中断・再開プロトコル

## 原則

PEAR Agentは、音声セッションを復元するシステムではありません。

> **Execution Sessionへ、新しいVoice Sessionを接続し直すシステムです。**

## 中断

AIまたはユーザーが中断を要求したら、Runtimeは同一トランザクションで次を行います。

1. 最新Runtime Snapshotを取得する
2. Continuationを保存する
3. `continuation_suspended`イベントを記録する
4. 時刻指定ならWakeをスケジュールする
5. 音声接続を閉じる

```ts
type WakeCondition =
  | { type: 'manual' }
  | { type: 'time'; wakeAt: string }
  | { type: 'event'; eventType: string };

type ExecutionContinuation = {
  id: string;
  sessionId: string;
  status: 'suspended' | 'wake_pending' | 'resuming' | 'completed' | 'expired';
  wakeCondition: WakeCondition;
  suspendedReason: string;
  resumeDirective: string;
  checkpointPlanVersionId: string;
  checkpointLastEventId: string | null;
  providerResumeHandle: string | null;
};
```

## Wake

Cloudflare Agentsのスケジュール機能を基本のWake機構とします。複数段階の耐障害処理や再計画パイプラインにはWorkflowsを使います。

## 再開

1. Continuationをatomicに`resuming`へ遷移する
2. 最新Runtime Snapshotを取得する
3. Provider resume handleが利用可能なら再利用する
4. 利用できなければ新しいVoice Sessionを作る
5. Snapshot、再開理由、Directiveを音声エージェントへ渡す
6. AIが現在状態を確認してから案内を始める
7. 成功後にContinuationを`completed`へ遷移する

handleは会話の滑らかさを高める補助情報です。handleの期限切れや欠落で再開できなくなってはいけません。

## 冪等性

同一Continuationへの二重再開を防ぐため、状態遷移は条件付き更新で行います。

```sql
UPDATE execution_continuations
SET status = 'resuming'
WHERE id = ?
  AND status IN ('suspended', 'wake_pending');
```

## 再開時の指示

1. Runtime Snapshotを正とする
2. 中断中に発生したイベントを確認する
3. 現在のPlan Versionを確認する
4. 必要なら再計画を要求する
5. ユーザーへ現在状態と次の行動を短く伝える
