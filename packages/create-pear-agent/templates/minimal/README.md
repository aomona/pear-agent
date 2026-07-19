# PEAR AI-native Starter

The default path is **Sources → Compile with LLM → Review → Execute → Assess → Replan**. Text, public URLs, PDF, Markdown, and JSON become a durable PlanArtifact with provenance and generation metadata. A deterministic PlanGenerator remains as an explicit adapter for tests and direct legacy session creation.

Compile requests are queued into the `PlanCompileWorkflow` binding. The browser polls the D1 job,
while Worker restarts and HTTP disconnects do not interrupt the compile lifecycle.

Generate this starter from the public beta with `pnpm dlx create-pear-agent@beta my-agent`. The scaffold pins all four PEAR Runtime packages to `0.1.0-beta.1`, uses no registry overrides, and owns the D1 baseline at `migrations/0001_init.sql`.

## Start

```bash
pnpm install
cp .env.example .env
cp .dev.vars.example .dev.vars
# Set GEMINI_API_KEY in .dev.vars
pnpm dev
```

Open the Vite URL printed by `pnpm dev`; if port 5173 is occupied it will choose another. The Worker runs at `http://127.0.0.1:8787`.

## Customize

- `src/domain/domain.ts` — Zod schemas, interpretation/planning/replanning prompts, and deterministic validation
- `src/worker/index.ts` — Vercel AI SDK model/provider selection and host authorization
- `src/app/pages/` — hooks-only product UI
- `src/pear.config.ts` — app identity, locale, API origin, and host context

The generated Worker fails closed unless `PEAR_INSECURE_ALLOW_ALL=true` is set. The example enables it only for local development. Replace the deny-all authorization hook before deployment.

## Verify and deploy

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm db:migrate:remote
pnpm deploy
```

Replace placeholder D1 and R2 identifiers in `wrangler.jsonc` before remote migration or deployment.
