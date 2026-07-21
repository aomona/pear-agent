# PEAR Agent 🍐

**Natural-language sources → Plan → Execute → Assess → Replan.**

PEAR Runtime は、レシピ、PDF、URL、メモなどの曖昧な入力を LLM で構造化し、一貫した実行計画へ変換して、現実の進行に合わせて更新し続ける Cloudflare-first TypeScript runtime です。

```text
Sources → Interpret → Clarify? → Plan → Review → Execute → Assess → Replan
                         ↑                                  │          │
                         └──────── durable artifacts ───────┴──────────┘
```

## AI-native by default

- `@pear-agent/ai` は Vercel AI SDK の structured output を使い、`SourceInterpreter`、Planner、Editor を provider-neutral に実装します。
- Gemini は検証済みの既定 provider です。text planning と Gemini Live realtime は別セッションです。
- Runtime が ID、version、状態遷移、認可、retry budget、provenance を所有します。LLM 出力は必ず Zod と Domain invariant を通ります。
- deterministic planner は明示 adapter / fixture として利用できます。AI 障害時の暗黙 fallback はしません。

## Packages (v0.1)

- `@pear-agent/core` — portable schemas, reducers, Domain/AI Ports, plan/replan contracts
- `@pear-agent/ai` — Vercel AI SDK structured interpretation, planning, editing, replan
- `@pear-agent/cloudflare` — Hono, Agents/DO, D1 + Drizzle, R2, compile/replan APIs
- `@pear-agent/react` — hooks-only plan compile, execution, continuation, voice APIs
- `create-pear-agent` — AI-first Minimal Starter scaffold

v0.1 の検証軸は **Runtime + Minimal Starter**（Sources → Compile → Review → Execute）です。  
Outing（`examples/outing-*`）は互換サンプルとして残します。Cook / Presentation などの本格 Reference Application は v0.1 外で別途作ります。

## Quick start

```bash
pnpm dlx create-pear-agent@beta my-agent
cd my-agent
pnpm install
cp .env.example .env
cp .dev.vars.example .dev.vars
# Set GEMINI_API_KEY in .dev.vars
pnpm dev
```

The starter pins all four PEAR Runtime packages to `0.1.0-beta.1`, carries its own `migrations/0001_init.sql`, and demonstrates **Sources → Compile → Review → Execute** with an artifact inspector. It fails closed outside local development until the host supplies authorization. During the beta, `--example outing` is not bundled in npm; use `--from <pear-agent-root>` or `PEAR_AGENT_ROOT` from a monorepo checkout.

## Documentation and Agent Skill

- Documentation site: [pear-agent-docs.pages.dev](https://pear-agent-docs.pages.dev/)
- Portable coding-agent skill: [`skills/pear-agent`](./skills/pear-agent)

```bash
npx skills add aomona/pear-agent --skill pear-agent
```

The skill guides greenfield and existing-app integration across Domain design, AI compile, Cloudflare bindings, React, verification, and deployment.

## Runtime state

- **PlanArtifact** — sources, interpretation revisions, clarification, plan versions, generation metadata
- **CompileJob** — durable compile phase/status/budget/error record
- **Execution Session** — durable real-world work state and event log
- **Voice Session** — temporary Gemini Live connection; never the source of truth
- **Continuation** — durable suspension and resume intent

## Development

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Architecture and behavioral contracts live in [`docs/`](./docs/). Start with the [AI-native RFC](./docs/rfcs/2026-07-15-ai-native-runtime.md), [requirements](./docs/requirements.md), and [architecture](./docs/architecture.md).
