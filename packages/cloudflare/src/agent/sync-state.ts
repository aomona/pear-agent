/**
 * Agent DO state used only for real-time client sync.
 * D1 remains the durable source of truth for Execution State.
 *
 * `snapshot` is JSON-safe (ISO date strings). Clients parse with Core schemas.
 * `continuation` is a stub until Issue #7.
 */
export type ExecutionSessionSyncState = {
  /** Monotonic counter so clients can ignore stale out-of-order updates. */
  revision: number;
  /** JSON-safe RuntimeSnapshot, or null when the session is not in D1 yet. */
  snapshot: unknown | null;
  /** Reserved for Issue #7 Continuation. Always null in this phase. */
  continuation: null;
};

export const EMPTY_SYNC_STATE: ExecutionSessionSyncState = {
  revision: 0,
  snapshot: null,
  continuation: null,
};

/** kebab-case agent path segment for `routeAgentRequest` / `useAgent`. */
export const EXECUTION_SESSION_AGENT_NAME = "execution-session-agent";
