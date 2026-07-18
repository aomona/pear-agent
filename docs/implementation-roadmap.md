# PEAR AI-native v0.1 Implementation Roadmap

## 完成条件（v0.1）

Runtime と AI-first Minimal Starter で次を完走します。

```text
Sources -> AI Compile -> Review -> Natural-language Edit -> Execute
```

Cook / Presentation などの本格 Reference Application は v0.1 の必須スコープ外です（後続で別途）。

## 統合 branch

すべての子PRは`feat/ai-native-runtime`をbaseにし、local gate と Starter smoke 通過後に`dev`へmergeします。

## Slices

1. AI-native RFCと正本Docs
2. Core source/compiler/provenance/Domain contracts
3. `@pear-agent/ai` Vercel AI SDK adapters
4. Cloudflare source storage、D1 baseline、Compile Workflow、HTTP API
5. React typed client/hooks（`usePlanCompiler` 含む）
6. AI-first Minimal Starter
7. Outing 互換サンプルの維持（必須 E2E ではない）
8. Artifact Inspector、hardening、公開 Docs

## Out of v0.1

- Cook Reference Application
- Presentation Reference Application
- Domain Marketplace / multi-template catalog

## Milestones

| 状態 | 完成物 |
| ---- | ------ |
| Done / in progress | RFC、Core、AI SDK、Cloudflare compile、React hooks、Starter |
| v0.1 exit | Starter smoke + local gate + docs の v0.1 契約一致 |
| Later | Cook / Presentation を Runtime 外（別 repo または examples）で再構築 |
