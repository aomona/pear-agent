# `@pear-agent/cloudflare`

Cloudflare Adapter for PEAR Runtime: Execution Session Agents, D1 persistence, R2 raw inputs, host authorization hooks, and a minimal Worker HTTP API.

## Architecture

- **D1** is the durable source of truth for sessions, events, materialized state, and normalized input.
- **Drizzle ORM** (`drizzle-orm/d1`) owns the typed schema (`src/d1/schema.ts`) and repository queries; SQL migrations live in `migrations/`.
- **ExecutionSessionAgent** (Cloudflare Agent / Durable Object) serializes mutations per `sessionId`.
- **R2** stores Raw Input bytes; metadata and checksums live in D1.
- **PlanGenerator** is injected by the host (AI SDK Planner in production, static fixtures in tests).

## Host Worker

```ts
import {
  createPearApp,
  ExecutionSessionAgent,
  type AuthorizeFn,
  type PlanGenerator,
} from "@pear-agent/cloudflare";

export { ExecutionSessionAgent };

const authorize: AuthorizeFn = async (operation, context) => {
  // throw AuthorizationError to deny
};

const planGenerator: PlanGenerator = {
  async generatePlan({ domainId, goal, normalizedInput, context }) {
    // Call AI SDK structured planner here
    return plan;
  },
};

const app = createPearApp({ authorize, planGenerator });

export default { fetch: app.fetch };
```

Bind `DB` (D1), `RAW_INPUTS` (R2), and `ExecutionSessionAgent` (Durable Object with SQLite migration) in Wrangler. Apply `migrations/0001_init.sql`.

## HTTP API

| Method | Path                                | Notes                                                                    |
| ------ | ----------------------------------- | ------------------------------------------------------------------------ |
| `GET`  | `/health`                           | No auth                                                                  |
| `POST` | `/sessions`                         | JSON: domainId, actorIds, goal, normalizedInput → PlanGenerator → create |
| `GET`  | `/sessions/:id`                     | Materialized state                                                       |
| `GET`  | `/sessions/:id/snapshot`            | Runtime snapshot                                                         |
| `POST` | `/sessions/:id/events`              | Append runtime event                                                     |
| `POST` | `/sessions/:id/raw-inputs`          | `multipart/form-data` field `file` or `raw` (default max 10 MiB)         |
| `GET`  | `/sessions/:id/raw-inputs/:inputId` | Raw input metadata                                                       |
| `PUT`  | `/sessions/:id/normalized-input`    | Replace normalized input                                                 |
| `GET`  | `/sessions/:id/normalized-input`    | Read normalized input                                                    |

Default auth context: `x-pear-context: {"actorId":"...","roles":[],"claims":{}}`.
