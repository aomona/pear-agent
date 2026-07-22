# PEAR Agent

[![npm](https://img.shields.io/npm/v/create-pear-agent?label=create-pear-agent&color=5f9f62)](https://www.npmjs.com/package/create-pear-agent)
[![CI](https://github.com/aomona/pear-agent/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/aomona/pear-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Build execution-support applications that turn unstructured sources into validated plans and keep them aligned with real-world progress.**

Sources → Interpret → Clarify → Plan → Review → Execute → Assess → Replan

[Documentation](https://pear-agent.aomona.me/) · [Quick Start](#quick-start) · [Agent Skill](./skills/pear-agent)

## What is PEAR Agent?

PEAR Agent is a Cloudflare-first TypeScript runtime for applications that guide people through real-world work.

It converts PDFs, URLs, notes, and other natural-language sources into validated plan artifacts, then manages execution through a durable **Plan → Execute → Assess → Replan** loop.

## Why PEAR?

| Capability                | Description                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Validated planning**    | AI output is checked against Zod schemas and host-defined domain invariants.           |
| **Durable execution**     | Execution state and event history survive reconnects, restarts, and long-running work. |
| **Controlled replanning** | Replans update only affected work while protecting completed and skipped steps.        |
| **Host-owned policy**     | The host application retains control of authorization, domain rules, UI, and adapters. |

## Quick Start

Requirements: Node.js 20 or later and pnpm.

```bash
pnpm dlx create-pear-agent@beta my-agent
cd my-agent
pnpm install
cp .env.example .env
cp .dev.vars.example .dev.vars
# Set GEMINI_API_KEY in .dev.vars
pnpm dev
```

The generated starter demonstrates **Sources → Compile → Review → Execute** with an artifact inspector. Gemini is the verified default provider. Authorization fails closed outside local development until the host supplies an authorization policy.

## How It Works

```text
Sources
   │
   ▼
Interpret ──► Clarify?
   │
   ▼
Plan ──► Review
   │
   ▼
Execute ──► Assess ──► Replan
   ▲                     │
   └─────────────────────┘
```

- **Plan Artifact** stores source references, interpretation revisions, clarification state, versioned plans, and generation metadata.
- **Execution Session** stores durable work state and its event history.
- **Voice Session** is an ephemeral Gemini Live connection and never the source of truth.
- **Continuation** stores durable suspension and resume intent.

## Packages

| Package                                             | Purpose                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`@pear-agent/core`](./packages/core)               | Portable schemas, pure reducers, domain ports, and plan/replan contracts               |
| [`@pear-agent/ai`](./packages/ai)                   | Structured interpretation, planning, editing, and replanning through the Vercel AI SDK |
| [`@pear-agent/cloudflare`](./packages/cloudflare)   | Hono APIs, Durable Objects, D1 + Drizzle, R2, and Workflows                            |
| [`@pear-agent/react`](./packages/react)             | Typed clients and React hooks for compile, execution, continuation, and voice          |
| [`create-pear-agent`](./packages/create-pear-agent) | Minimal AI-first starter generator                                                     |

## Core Guarantees

- AI and tool output never mutate runtime state directly.
- Every external boundary is validated with Zod and host-defined domain invariants.
- Runtime mutations pass through typed events and pure reducers.
- Event append and materialized-state updates remain atomic and idempotent.
- HTTP snapshots are the source of truth; WebSockets only signal invalidation.
- Replanning cannot silently rewrite completed or skipped work.
- AI failures do not trigger an implicit deterministic fallback.

## Documentation

Read the complete documentation at **[pear-agent.aomona.me](https://pear-agent.aomona.me/)**.

- [Getting Started](https://pear-agent.aomona.me/guide/getting-started)
- [Core Concepts](https://pear-agent.aomona.me/guide/concepts)
- [Domain Design](https://pear-agent.aomona.me/guide/domain)
- [AI Compilation](https://pear-agent.aomona.me/guide/ai-compilation)
- [Cloudflare Integration](https://pear-agent.aomona.me/guide/cloudflare)
- [React Integration](https://pear-agent.aomona.me/guide/react)

Architecture and behavioral contracts live in [`docs/`](./docs/). Start with the [AI-native RFC](./docs/rfcs/2026-07-15-ai-native-runtime.md), [requirements](./docs/requirements.md), and [architecture](./docs/architecture.md).

### Agent Skill

Install the portable PEAR Agent skill for coding agents:

```bash
npx skills add aomona/pear-agent --skill pear-agent
```

The skill covers domain design, AI compilation, Cloudflare bindings, React integration, verification, and deployment for both new and existing applications.

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

The required pre-push gate is:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

## Project Status

PEAR Agent is currently in beta. APIs may change before the stable `0.1` release.

## License

Released under the [MIT License](./LICENSE).
