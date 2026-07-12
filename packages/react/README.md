# `@pear-agent/react`

Typed Worker client, `PearProvider`, and hooks for PEAR Execution Runtime — without a fixed UI kit.

## Install

Workspace:

```json
{
  "dependencies": {
    "@pear-agent/react": "workspace:*",
    "@pear-agent/core": "workspace:*",
    "react": "^19.0.0",
    "agents": "^0.17.0"
  }
}
```

`agents` is required for realtime Agent WebSocket sync. Set `realtime={false}` on `PearProvider` to use HTTP-only snapshot loads (tests / offline tooling).

## Host Worker

Use `createPearWorker` from `@pear-agent/cloudflare` so `/agents/execution-session-agent/:sessionId` is routed and authorized for WebSockets (`session.read` via `?pearContext=`).

## Sync model

- **HTTP** is the source of truth for Runtime Snapshots (`GET /sessions/:id/snapshot`).
- **Agent WebSocket** broadcasts a lightweight invalidation pulse (`revision`, `lastEventId`).
- On revision advance or reconnect, hooks re-fetch the snapshot over HTTP.
- Snapshot + continuation hooks share one channel per session + client instance.

## Usage

```tsx
import {
  PearProvider,
  useExecutionSession,
  useRuntimeSnapshot,
  useContinuation,
} from "@pear-agent/react";

function App() {
  return (
    <PearProvider
      baseUrl="https://my-worker.example.workers.dev"
      // Inline getContext is fine — the provider keeps PearClient stable.
      getContext={() => ({
        actorId: "user-1",
        roles: ["owner"],
        claims: {},
      })}
    >
      <SessionPanel />
    </PearProvider>
  );
}

function SessionPanel() {
  // Unbound: omit the argument (or pass null). Do not pass null if you meant controlled mode.
  const session = useExecutionSession();
  // Snapshot + continuation share one session channel (one WS / HTTP hydrate).
  const { snapshot, continuation, status, error, refetch } = useRuntimeSnapshot(session.sessionId);
  // Optional alias if you only need continuation fields:
  // const cont = useContinuation(session.sessionId);

  void snapshot;
  void continuation;
  void status;
  void error;
  void refetch;
  return null;
}
```

### Hooks

| Hook                  | Role                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `useExecutionSession` | Create/bind session; type-safe step/timer/event actions                              |
| `useRuntimeSnapshot`  | HTTP hydrate + Agent pulse invalidation; loading/error/reconnect                     |
| `useContinuation`     | Durable Continuation read model plus suspend / claim-resume / complete operations    |
| `useVoiceSession`     | Voice Lease + ephemeral token + Live connect; tool bridge; disconnect ≠ session stop |

```tsx
import { useVoiceSession, FakeVoiceProvider } from "@pear-agent/react";

function VoicePanel({ sessionId }: { sessionId: string }) {
  const voice = useVoiceSession(sessionId);
  // Tests: useVoiceSession(sessionId, { provider: new FakeVoiceProvider() })
  return (
    <button type="button" onClick={() => void voice.connect()}>
      Connect voice ({voice.status})
    </button>
  );
}
```

Optional peer: `@google/genai` for `GeminiLiveVoiceProvider` (default when no `provider` override).

### Partial Replanning

Use `PearClient.requestReplan(sessionId, mode)`, `confirmPlanPatch(sessionId, patchId)`, and `getLatestPlanChange(sessionId)` for the three Replan modes. `RuntimeSnapshot.latestPlanChange` carries the latest Patch status, cause Events, failure reason, and operation list, so UI can distinguish proposed/rejected/applied diffs without diffing whole Plans.

### Auth

- HTTP: `getContext()` → `x-pear-context`
- Agent WebSocket: same context as `?pearContext=` (JSON), authorized as `session.read` on the Worker
