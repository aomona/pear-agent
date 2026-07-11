# PEAR Runtime Implementation Roadmap

## 目標

2026年8月20日までに、CLIから外出準備サンプルを生成し、Cloudflareへデプロイして、音声実行、中断、Wake、再開、部分再計画を実演できる状態にします。

## 実装計画の分割

1. **Foundation** — workspace、Core、Goal、Plan DAG、Step State、Domain Contract
2. **Execution State** — Session、WorldState、Event、Timer、Snapshot
3. **Cloudflare Runtime** — Agents、D1、R2、認可Hook
4. **React Client** — 型安全なClient、Provider、hooks、リアルタイム同期
5. **Gemini Voice** — Voice契約、Gemini Live、Voice Lease、Tool bridge
6. **Continuation** — Suspend、Wake、Atomic Resume、Snapshot Rehydration
7. **Partial Replanning** — Assess、Impact Analysis、Plan Patch、Version更新
8. **CLI and Outing Sample** — CLI、外出準備Domain、サンプルUI、deploy
9. **Devtools and Hardening** — Devtools、E2E、failure recovery、デモ試験
10. **PEAR Cook Integration** — cook-agentを第二Reference Applicationとして接続

## マイルストーン

| 日付 | 完成状態 |
| --- | --- |
| 7月17日 | FoundationとDomain Contract |
| 7月24日 | Execution StateとCloudflare Runtime |
| 7月31日 | React ClientとGemini Voice |
| 8月7日 | Continuationの中断・Wake・再開 |
| 8月13日 | 部分再計画と外出準備サンプル |
| 8月17日 | CLI、Devtools、E2E |
| 8月20日 | デモ安定化、文書、動画撮影可能状態 |

最初に実行する詳細計画は[PEAR Runtime Foundation Implementation Plan](./superpowers/plans/2026-07-11-pear-runtime-foundation.md)です。
