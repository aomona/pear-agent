# 状態モデル

## SourceとCompile

- Source Artifact: type、location、media type、checksum、size、R2 key、抽出状態
- Interpretation Artifact: Domain型付きNormalized Input、assumptions、source refs、revision
- Clarification: question、affected fields/sources、status、answer
- Generation Record: stage、provider/model、prompt/schema version、usage、warnings、validation
- Compile Job: Workflow ID、phase、status、attempt、budget、error、timestamps

## Plan Artifact

Plan ArtifactはExecution Sessionから独立した再利用可能なdraft/ready/stale/archived Planです。
各versionはparent、change reason、typed cause refs、Plan、diff、generation recordを持ちます。
各Stepは一つ以上のsource refsを持ちます。Runtimeがartifact、Patch、StepのIDを割り当てます。

## Execution State

Execution Sessionは開始時のPlan Artifact versionをsnapshot/forkし、Plan、WorldState、
Step States、Timers、Events、Continuation、active Plan Changeを保持します。
Runtime Snapshotがresume/read modelであり、provider chat historyは正本ではありません。

## 独立するライフサイクル

- Compile Workflow: sourceからreview可能Planまで
- Plan Artifact: draft/ready/stale/archivedとversion履歴
- Execution Session: durableな実行状態
- Voice Session:一時的なRealtime接続
- Continuation:中断とwake/resume

Session内Replanは元Artifactを更新しません。Sessionの最終Planは明示的に新しいArtifactへ保存できます。
