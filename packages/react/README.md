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

Use `createPearWorker` from `@pear-agent/cloudflare` so `/agents/execution-session-agent/:sessionId` is routed for WebSockets.

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
  const session = useExecutionSession();
  const { snapshot, status, error, refetch } = useRuntimeSnapshot(session.sessionId);
  const continuation = useContinuation(session.sessionId);

  // no UI components forced — render however you like
  return null;
}
```

### Hooks

| Hook                  | Role                                                        |
| --------------------- | ----------------------------------------------------------- |
| `useExecutionSession` | Create/bind session; type-safe step/timer/event actions     |
| `useRuntimeSnapshot`  | HTTP hydrate + Agent realtime sync; loading/error/reconnect |
| `useContinuation`     | Thin stub (`null` / `status: "none"` until Issue #7)        |

Auth: host supplies `getContext()` → sent as `x-pear-context` on HTTP.
