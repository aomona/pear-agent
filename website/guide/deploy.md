# Deploy

Deploy only after the complete local source-to-session path works.

## Verify locally

Use the generated application's scripts:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Then run the application and exercise the changed path. Unit tests do not prove Worker bindings or WebSocket routing.

## Provision Cloudflare resources

Create or select the resources named by `wrangler.jsonc`:

- D1 database;
- R2 bucket;
- Durable Object migration for `ExecutionSessionAgent`;
- Workflow binding for compile orchestration.

Replace placeholder IDs in the generated config. Keep preview/production resources distinct when the host's release process requires it.

## Install secrets

```bash
pnpm exec wrangler secret put GEMINI_API_KEY
```

Provider keys never belong in `.env` values prefixed with `VITE_`, committed config, browser code, or public CI logs.

## Apply migrations

Use the generated script, commonly:

```bash
pnpm db:migrate:remote
```

Apply every required migration before routing production traffic. The generated project owns its migration baseline; compare new package migrations deliberately during upgrades.

## Deploy

```bash
pnpm deploy
```

When the frontend and Worker use different origins, set `VITE_PEAR_API_URL` at frontend build time to the deployed Worker origin. Configure the host's CORS and auth policy explicitly.

## Production smoke path

1. Request `/health`.
2. Authenticate through the host.
3. Create a draft Plan Artifact.
4. Add a source and run a compile Workflow.
5. Review and ready the artifact.
6. Create an Execution Session.
7. Mutate one step and confirm a WebSocket pulse leads to a newer HTTP Snapshot.

This path establishes the D1, R2, Workflow, Agent, auth, and browser boundaries together.

## Fail-closed checklist

- production does not use `allowAllAuthorize`;
- actor/tenant identity is derived from verified host authentication;
- unauthorized requests are rejected before reads, writes, uploads, and AI calls;
- compile cancellation reaches provider calls;
- D1 writes remain atomic/idempotent;
- browser bundles contain no provider secret;
- voice disconnect does not stop execution;
- stale replan patches cannot activate.
