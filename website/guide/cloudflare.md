# Wire Cloudflare

`@pear-agent/cloudflare` supplies the Hono API, Agent/Durable Object serialization, D1 repositories, R2 source storage, compile Workflow runner, and optional replan/voice adapters.

## Host shape

```text
request
  → createPearWorker
  → authorize(operation, context)
  → Domain + AI adapter
  → ExecutionSessionAgent.runExclusive
  → D1 transaction/batch
  → invalidation pulse
```

Prefer `createPearWorker()` for applications using `@pear-agent/react` realtime sync. `createPearApp()` is HTTP-only.

## Worker entry

```ts
import { ExecutionSessionAgent, createPearWorker, type AuthorizeFn } from "@pear-agent/cloudflare";

export { ExecutionSessionAgent };

const authorize: AuthorizeFn = async (operation, context) => {
  if (!context.actorId) throw new AuthorizationError("Authentication required");
  await policy.assertAllowed(context.actorId, operation, context);
};

const worker = createPearWorker({
  authorize,
  // Inject plan library, compiler, replan and voice adapters here.
});

export default { fetch: worker.fetch };
```

Use the generated starter's `src/worker/index.ts` as the complete current wiring reference. It resolves provider-backed adapters from the current Worker environment and exports the compile Workflow.

## Bindings

A full starter config includes:

| Binding                 | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `DB`                    | D1 durable source of truth                       |
| `RAW_INPUTS`            | R2 source/file bytes                             |
| `ExecutionSessionAgent` | per-session serialized mutation and invalidation |
| `PLAN_COMPILE_WORKFLOW` | durable compile orchestration                    |
| `GEMINI_API_KEY`        | Worker-only secret for AI/voice                  |

Keep the generated baseline migration in the application and point Wrangler at that local `migrations` directory.

## Authorization must precede effects

The host owns authentication and authorization. Treat `PearRequestContext` as request context, not proof by itself. Deny before D1/R2 writes and before AI calls. The Minimal Starter can explicitly allow all during local development; production must remain fail-closed.

## Durable mutation rules

- D1 is authoritative; Agent storage is not a parallel database.
- Serialize session read-modify-write through `ExecutionSessionAgent`.
- Append the Runtime Event and update materialized state atomically.
- Preserve global event ID uniqueness and operation idempotency keys.
- Broadcast only revision metadata. Clients refetch the HTTP Snapshot.

## Sources

R2 holds raw bytes. D1 holds source metadata, checksums, interpretation records, clarification state, compile jobs, and artifact versions. Validate upload size/type and authorization before durable writes.

## Run locally

```bash
pnpm db:migrate:local
pnpm dev
```

Check `/health`, then exercise an authenticated plan route. A healthy Worker alone does not prove D1, R2, Workflow, or Agent wiring; complete the source-to-session path from the browser.
