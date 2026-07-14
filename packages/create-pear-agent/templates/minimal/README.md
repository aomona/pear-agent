# PEAR Minimal Starter

A small, deployable PEAR Runtime app. It demonstrates the durable flow without tying your project to the Outing reference domain:

1. list plans
2. enter domain input
3. review the generated plan
4. execute durable steps

## Start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://127.0.0.1:5173`. The Worker runs on `http://127.0.0.1:8787`.

## Edit

- `src/app/pages/` — replace the four product pages
- `src/domain/` — change schemas, normalization, goals, and plan generation
- `src/pear.config.ts` — change app identity, API origin, and host context
- `src/worker/index.ts` — replace development authorization when connecting real users

Runtime state, D1 persistence, R2 input storage, and Agent WebSocket wiring stay behind `@pear-agent/cloudflare` and `@pear-agent/react`.

## Verify and deploy

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm db:migrate:remote
pnpm deploy
```

Before remote commands, replace the placeholder D1 `database_id` and R2 bucket name in `wrangler.jsonc` with your Cloudflare resources.
