# PEAR AI-native v0.1 Implementation Roadmap

## 完成条件

2026年8月20日までにCookとPresentationで次を完走します。

```text
Sources -> AI Compile -> Review -> Natural-language Edit -> Realtime Execute -> Replan
```

## 統合branch

すべての子PRは`feat/ai-native-runtime`をbaseにし、全E2Eとlocal gate通過後に`dev`へmergeします。

## Slices

1. AI-native RFCと正本Docs
2. Core source/compiler/provenance/Domain contracts
3. `@pear-agent/ai` Vercel AI SDK adapters
4. Cloudflare source storage、D1 baseline、Compile Workflow、PlanArtifactAgent、HTTP API
5. React typed client/hooksとCore diff view model
6. AI-first Minimal Starter
7. Cook Reference Application（主E2E、mobile execution）
8. Presentation Reference Application（PDF/time vertical slice）
9. Gemini Live domain executionとstructured observations
10. Artifact Inspector、Playwright、live provider smoke、hardening

## Milestones

| 日付    | 完成状態                                |
| ------- | --------------------------------------- |
| 7月18日 | RFCと正本Docs                           |
| 7月24日 | CoreとAI SDK adapter                    |
| 7月31日 | Cloudflare compile runtimeとReact hooks |
| 8月7日  | AI-first StarterとCook                  |
| 8月13日 | PresentationとRealtime Replan           |
| 8月20日 | E2E、Devtools、verification、公開Docs   |
