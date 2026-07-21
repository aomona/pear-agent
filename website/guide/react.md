# Connect React

`@pear-agent/react` provides a typed `PearClient`, `PearProvider`, a shared session channel, and hooks. It deliberately does not prescribe a UI kit.

## Add the provider

```tsx
import { PearProvider } from "@pear-agent/react";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PearProvider
      baseUrl={import.meta.env.VITE_PEAR_API_URL || window.location.origin}
      getContext={() => ({ actorId: currentUser.id, roles: currentUser.roles, claims: {} })}
    >
      {children}
    </PearProvider>
  );
}
```

The Worker must still authenticate and authorize the request. Do not trust a browser-supplied actor ID by itself.

## Four clear surfaces

### Plans

List independent Plan Artifacts and expose draft/ready state. A Plan Artifact can exist without an Execution Session.

### Sources

Create a draft, add text/URL/file sources, start a compile job, display phase progress, and answer clarifications.

### Review

Render the Plan DAG, dependencies, timing/resources, provenance, validation issues, edit proposals, and artifact versions. The user decides when a valid artifact is ready.

### Execute

Bind or create an Execution Session, render ready/blocked/current steps, and emit typed Runtime actions.

```tsx
import { useExecutionSession, useRuntimeSnapshot } from "@pear-agent/react";

function ExecutionPanel() {
  const session = useExecutionSession();
  const { snapshot, continuation, status, error, refetch } = useRuntimeSnapshot(session.sessionId);

  if (status === "loading") return <p>Loading current execution…</p>;
  if (error) return <button onClick={() => void refetch()}>Retry snapshot</button>;
  if (!snapshot) return null;

  return <PlanSteps plan={snapshot.plan} states={snapshot.stepStates} />;
}
```

## Sync model

HTTP Snapshots are authoritative. The Agent WebSocket sends a lightweight invalidation pulse. On revision advance or reconnect, the shared session channel refetches HTTP. Snapshot and continuation hooks reuse one channel per session/client; do not add a second custom socket.

Set `realtime={false}` only for HTTP-only tooling or tests.

## Required UI states

Model durable states rather than one generic spinner:

- compile queued, interpreting, clarification, planning, failed, cancelled, complete;
- artifact draft, ready, or superseded version;
- step blocked, ready, active, paused, completed, skipped, or failed;
- socket hydrating, live, reconnecting, or HTTP-only;
- replan proposed, confirmation required, applied, rejected, or failed.

An error message should name the action that failed and the next recovery action.

## User-visible invariants

- Voice disconnect does not stop the Execution Session.
- Plan review is not execution.
- A replan proposal shows its validated operation list and causes.
- Optimistic UI never replaces an authoritative Snapshot without a visible pending state.
