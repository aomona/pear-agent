# Getting started

Create a Cloudflare-first PEAR application with React, D1, R2, Agents, Workflows, and Gemini-backed structured compilation.

## Prerequisites

- Node.js 20 or newer
- pnpm
- a Cloudflare account for remote resources and deployment
- a Gemini API key only when exercising AI compile or voice

## Scaffold the Minimal Starter

```bash
pnpm dlx create-pear-agent@beta my-agent
cd my-agent
pnpm install
cp .env.example .env
cp .dev.vars.example .dev.vars
```

Put `GEMINI_API_KEY` in `.dev.vars`. Never use a `VITE_` prefix for provider secrets: Vite exposes those values to browser code.

Initialize local D1 and start the app:

```bash
pnpm db:migrate:local
pnpm dev
```

The generated README is authoritative for its scripts. The starter keeps the main product seams small:

```text
src/
├── app/pages/       # plans, source input, review, execution
├── domain/          # Zod schemas, Domain policy, fallback plan
├── worker/          # provider and Cloudflare adapter wiring
└── pear.config.ts   # app name, Domain id, actor/context, API origin
```

## First successful path

Do not begin with voice or replan. Prove the base vertical slice:

1. Open **Plans** and create a draft Plan Artifact.
2. Add source text, a URL, or a file.
3. Start compile. Answer a clarification if one is required.
4. Review the generated DAG and its source provenance.
5. Mark the artifact ready.
6. Create an Execution Session from that artifact.
7. Complete one ready step and observe the Snapshot update.

This proves the important boundaries together: browser → Worker → authorization → source storage → AI compile → Plan validation → D1 → Agent mutation → HTTP Snapshot.

## Make it yours

Change these in order:

1. [`src/domain/domain.ts`](/guide/domain): schemas and policy.
2. `src/pear.config.ts`: product name, Domain id, and host context.
3. [`src/app/pages/`](/guide/react): product interaction and visual language.
4. [`src/worker/index.ts`](/guide/cloudflare): production auth and provider/runtime adapters.

The published Runtime packages are dependencies, not copied implementation. Keep application-specific fields in your Domain and UI.

## Existing application

For an existing React + Cloudflare application, use the [Agent Skill](/guide/agent-skill) to inspect the host before integrating. A complete host commonly uses:

```bash
pnpm add @pear-agent/core@beta @pear-agent/ai@beta @pear-agent/cloudflare@beta @pear-agent/react@beta
pnpm add ai @ai-sdk/google zod react agents
pnpm add -D wrangler @cloudflare/workers-types
```

Prefer adopting the starter's boundaries over copying its finished pages. Reuse existing routing, auth, design system, and deployment conventions.
