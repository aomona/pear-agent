# `@pear-agent/cloudflare`

Cloudflare Adapter for PEAR Runtime: Execution Session Agents, D1 persistence, R2 raw inputs, host authorization hooks, and a minimal Worker HTTP API.

## Architecture

- **D1** is the durable source of truth for sessions, events, materialized state, and normalized input.
- **Drizzle ORM** (`drizzle-orm/d1`) owns the typed schema (`src/d1/schema.ts`) and repository queries; SQL migrations live in `migrations/`.
- **ExecutionSessionAgent** (Cloudflare Agent / Durable Object) serializes mutations per `sessionId` via typed DO RPC; D1 text columns are the JSON boundary.
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

// Prefer createPearWorker so React clients can subscribe via agents WebSocket
// (`/agents/execution-session-agent/:sessionId`). createPearApp is HTTP-only.
const worker = createPearWorker({ authorize, planGenerator });

export default { fetch: worker.fetch };
```

Bind `DB` (D1), `RAW_INPUTS` (R2), and `ExecutionSessionAgent` (Durable Object with SQLite migration) in Wrangler. Apply `migrations/0001_init.sql`.

## HTTP API

| Method   | Path                                                        | Notes                                                                    |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET`    | `/health`                                                   | No auth                                                                  |
| `POST`   | `/sessions`                                                 | JSON: domainId, actorIds, goal, normalizedInput → PlanGenerator → create |
| `GET`    | `/sessions/:id`                                             | Materialized state                                                       |
| `GET`    | `/sessions/:id/snapshot`                                    | Runtime snapshot                                                         |
| `POST`   | `/sessions/:id/events`                                      | Append runtime event                                                     |
| `POST`   | `/sessions/:id/raw-inputs`                                  | `multipart/form-data` field `file` or `raw` (default max 10 MiB)         |
| `GET`    | `/sessions/:id/raw-inputs/:inputId`                         | Raw input metadata                                                       |
| `PUT`    | `/sessions/:id/normalized-input`                            | Replace normalized input                                                 |
| `GET`    | `/sessions/:id/normalized-input`                            | Read normalized input                                                    |
| `POST`   | `/sessions/:id/continuations`                               | Suspend and persist a Continuation checkpoint                            |
| `GET`    | `/sessions/:id/continuation`                                | Read the active Continuation                                             |
| `POST`   | `/sessions/:id/continuations/:continuationId/resume`        | Atomically claim resume                                                  |
| `POST`   | `/sessions/:id/continuations/:continuationId/complete`      | Complete a connected resume                                              |
| `POST`   | `/sessions/:id/continuations/:continuationId/resume-failed` | Return a failed resume to `wake_pending`                                 |
| `POST`   | `/sessions/:id/voice/lease`                                 | Acquire exclusive Voice Lease (Issue #6)                                 |
| `GET`    | `/sessions/:id/voice/lease`                                 | Active lease or null                                                     |
| `DELETE` | `/sessions/:id/voice/lease`                                 | Release lease (does **not** stop Execution Session)                      |
| `PUT`    | `/sessions/:id/voice/resume-handle`                         | Persist Gemini resume handle on the lease                                |
| `POST`   | `/sessions/:id/voice/token`                                 | Mint Live ephemeral token (server `GEMINI_API_KEY`)                      |
| `POST`   | `/sessions/:id/voice/tools`                                 | Tool bridge (authorize + built-in / capability tools → appendEvent)      |

Default auth context: `x-pear-context: {"actorId":"...","roles":[],"claims":{}}`.

### Voice (Issue #6)

- Bind optional secret `GEMINI_API_KEY` for real token minting (never ship to clients).
- Install optional peer `@google/genai` on the Worker when using the default Google minter.
- Apply D1 migration `0002_voice_leases.sql`.
- Inject `voiceTokenMinter` on `createPearApp` for tests (real mint uses `GEMINI_API_KEY` + optional `@google/genai`).
