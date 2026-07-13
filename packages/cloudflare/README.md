# `@pear-agent/cloudflare`

Cloudflare Adapter for PEAR Runtime: Execution Session Agents, D1 persistence, R2 raw inputs, host authorization hooks, and a minimal Worker HTTP API.

## Architecture

- **D1** is the durable source of truth for sessions, events, materialized state, normalized input, Plan Patches, and immutable Plan Versions.
- **Drizzle ORM** (`drizzle-orm/d1`) owns the typed schema (`src/d1/schema.ts`) and repository queries; SQL migrations live in `migrations/`.
- **ExecutionSessionAgent** (Cloudflare Agent / Durable Object) serializes mutations per `sessionId` via typed DO RPC; D1 text columns are the JSON boundary.
- **R2** stores Raw Input bytes; metadata and checksums live in D1.
- **PlanGenerator** is injected by the host (AI SDK Planner in production, static fixtures in tests).
- **ReplanRuntime** is injected by the host (AI SDK structured Assess/Patch generation in production); PEAR computes the affected DAG subgraph and validates the result before activation.

## Host Worker

```ts
import {
  createPearWorker,
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
const replanRuntime = {
  generator: aiSdkReplanGenerator,
  resolveConfiguration: (domainId: string) => ({
    instructions: "Update only the affected steps",
    domainVersion: 1,
    defaultMode: "automatic" as const,
    stepDataSchema: domain.schemas.stepData,
    capabilityPolicies: domain.capabilities.map(({ id, executionMode, riskLevel }) => ({
      id,
      executionMode,
      riskLevel,
    })),
    reconcileWorldState(plan, worldState) {
      // Validate Domain facts/requirements and return recalculated resource usage.
      return reconciledWorldState;
    },
  }),
};

const worker = createPearWorker({ authorize, planGenerator, replanRuntime });

export default { fetch: worker.fetch };
```

Bind `DB` (D1), `RAW_INPUTS` (R2), and `ExecutionSessionAgent` (Durable Object with SQLite migration) in Wrangler. Apply every SQL migration in order through `migrations/0004_replanning.sql`.

Migration `0004` marks pre-existing sessions with Domain version `0` (unknown/incompatible) instead of guessing a schema version. Migrate those sessions explicitly before replanning; newly created sessions persist the resolved Domain version.

## HTTP API

| Method   | Path                                                        | Notes                                                                                   |
| -------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET`    | `/health`                                                   | No auth                                                                                 |
| `POST`   | `/sessions`                                                 | JSON: domainId, actorIds; either (goal + normalizedInput) **or** ready `planArtifactId` |
| `GET`    | `/plans?domainId=&status=`                                  | Plan library list (CE-11)                                                               |
| `POST`   | `/plans`                                                    | Create draft/ready plan artifact                                                        |
| `GET`    | `/plans/:id`                                                | Artifact + optional normalizedInput                                                     |
| `PATCH`  | `/plans/:id`                                                | title / status / plan edit / normalizedInput                                            |
| `POST`   | `/plans/:id/generate`                                       | Run PlanGenerator into artifact                                                         |
| `POST`   | `/plans/:id/normalize`                                      | Domain normalize (+ optional freeTextResolver)                                          |
| `POST`   | `/plans/:id/resolve-field`                                  | Single free-text field → structured (modal add / optional LLM)                          |
| `POST`   | `/plans/:id/improve`                                        | PlanImprover (host-injected)                                                            |
| `GET`    | `/plans/:id/versions`                                       | Artifact version history                                                                |
| `GET`    | `/sessions/:id`                                             | Materialized state                                                                      |
| `GET`    | `/sessions/:id/snapshot`                                    | Runtime snapshot                                                                        |
| `POST`   | `/sessions/:id/events`                                      | Append runtime event                                                                    |
| `POST`   | `/sessions/:id/raw-inputs`                                  | `multipart/form-data` field `file` or `raw` (default max 10 MiB)                        |
| `GET`    | `/sessions/:id/raw-inputs/:inputId`                         | Raw input metadata                                                                      |
| `PUT`    | `/sessions/:id/normalized-input`                            | Replace normalized input                                                                |
| `GET`    | `/sessions/:id/normalized-input`                            | Read normalized input                                                                   |
| `POST`   | `/sessions/:id/continuations`                               | Suspend and persist a Continuation checkpoint                                           |
| `GET`    | `/sessions/:id/continuation`                                | Read the active Continuation                                                            |
| `POST`   | `/sessions/:id/continuations/:continuationId/resume`        | Atomically claim resume                                                                 |
| `POST`   | `/sessions/:id/continuations/:continuationId/complete`      | Complete a connected resume                                                             |
| `POST`   | `/sessions/:id/continuations/:continuationId/resume-failed` | Return a failed resume to `wake_pending`                                                |
| `POST`   | `/sessions/:id/replans`                                     | Assess impact and propose/apply a partial Plan Patch                                    |
| `POST`   | `/sessions/:id/plan-patches/:patchId/confirm`               | Confirm and activate a pending patch                                                    |
| `GET`    | `/sessions/:id/plan-patches/latest`                         | Read latest patch status and diff                                                       |
| `POST`   | `/sessions/:id/voice/lease`                                 | Acquire exclusive Voice Lease (Issue #6)                                                |
| `GET`    | `/sessions/:id/voice/lease`                                 | Active lease or null                                                                    |
| `DELETE` | `/sessions/:id/voice/lease`                                 | Release lease (does **not** stop Execution Session)                                     |
| `PUT`    | `/sessions/:id/voice/resume-handle`                         | Persist Gemini resume handle on the lease                                               |
| `POST`   | `/sessions/:id/voice/token`                                 | Mint Live ephemeral token (server `GEMINI_API_KEY`)                                     |
| `POST`   | `/sessions/:id/voice/tools`                                 | Tool bridge (authorize + built-in / capability tools → appendEvent)                     |

Default auth context: `x-pear-context: {"actorId":"...","roles":[],"claims":{}}`.
Replan requests call the host hook first with mode-neutral `replan.preflight` before reading session/config data, then with `replan.request` and the resolved effective mode.

### Voice (Issue #6)

- Bind optional secret `GEMINI_API_KEY` for real token minting (never ship to clients).
- Install optional peer `@google/genai` on the Worker when using the default Google minter.
- Apply D1 migration `0002_voice_leases.sql`.
- Inject `voiceTokenMinter` on `createPearApp` for tests (real mint uses `GEMINI_API_KEY` + optional `@google/genai`).

### Plan library (CE-11)

Session-independent plans live in D1 tables `plan_artifacts` / `plan_artifact_versions` (migration `0005_plan_artifacts.sql`). Do **not** confuse with session-scoped `plan_versions` (runtime replan history).

- Status flow: `draft` → generate steps → `ready` → `POST /sessions` with `planArtifactId` (skips PlanGenerator).
- Host may inject `planLibrary.normalizeDomainInput`, `freeTextResolver`, and `planImprover` on `createPearApp` / `createPearWorker`.
- Static host ports support deterministic or already-configured services. Use the corresponding
  `create*` factory when a port needs bindings from the current Worker environment; the factory
  takes precedence over the static fallback. Internally, routes consume these adapters as grouped
  generator, free-text, improvement, and domain ports, so this is the single injection convention.

### Partial Replanning (Issue #8)

`automatic` applies only safe ready/blocked changes immediately. A request can make the Domain default stricter but cannot weaken it; Capability execution/risk policy can further escalate to `confirm` or `suggest`. `confirm` persists a pending patch, and `suggest` is terminal advisory output. Changes to active Steps stay pending until the affected Steps and Session are explicitly paused, all running timers are paused/cancelled, and a human confirms; an interruption Continuation may be recorded in the same flow.

The replan **operational cursor** (`baseLastEventId` / `currentLastEventId`) ignores audit events (`replan_proposed`, `replan_failed`, `plan_updated`, `continuation_*`). Worker routes evaluate patches with `phase: "proposal"` (Domain schema + WorldState policy); the Agent activates with `phase: "activation"` after mode/confirmation gates.

The required `reconcileWorldState` policy validates Domain facts and requirements and returns recalculated resource utilization. Activation writes the Patch, new immutable Plan Version, reconciled WorldState, `plan_updated` Event, materialized state, and active session version in one D1 batch. Append-order cursors, session Domain version, normalized-input revision, two-level cause/attempt idempotency, and compare-and-swap prevent stale/double activation; validation/generation failures keep the previous Plan and append a sanitized `replan_failed`.
