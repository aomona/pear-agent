# MVP仕様

## 2026年8月20日の成功シナリオ

```text
CLIで外出準備サンプルを生成 → Cloudflareへデプロイ
→ 計画生成 → セッション開始 → 音声案内 → タイマー開始
→ 音声中断 → Continuation保存 → ページ再読み込み
→ Wake → 新しい音声接続 → Snapshot再同期
→ 遅延イベント → 再計画 → 差分表示
```

## 必須機能

- 外出準備入力と計画生成
- DAGと複数Stepの並行実行
- Execution Sessionの開始・一時停止・完了
- Runtime Eventの記録
- タイマーの作成と完了
- 手動または時刻指定のContinuation
- 再開時のSnapshot再同期
- Plan Versionの更新
- Affected Subgraphだけを変更するPlan Patch
- 再計画前後の差分表示
- React hooks
- CLIと簡易Devtools

## 受け入れ条件

- ページ再読み込み後も中断状態が失われない
- 音声Providerのresume handleがなくても再開できる
- 同じContinuationに対する二重再開を防げる
- 音声セッションの停止がExecution Sessionの停止を意味しない
- 再開後、AIは最新Snapshotを確認する
- 再計画で完了済み工程を未完了へ戻さない

## 初期対象外

- タブを閉じた状態からの自動音声再生
- Push通知
- 複数端末・複数人の同時編集
- 共同編集UI
- 大規模な外部サービス連携
