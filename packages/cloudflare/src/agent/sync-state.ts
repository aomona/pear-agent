/**
 * Agent DO state used only for real-time client invalidation.
 * D1 remains the durable source of truth for Execution State.
 *
 * Clients treat this as a pulse: on revision advance, re-fetch the
 * Runtime Snapshot over HTTP. Do not embed full snapshots here — that
 * duplicates the read model and can clobber richer HTTP windows.
 *
 * `continuation` is a stub until Issue #7.
 */
export type ExecutionSessionSyncState = {
  /** Monotonic counter so clients can ignore stale out-of-order updates. */
  revision: number;
  /** Id of the latest applied event, when known; null if none. */
  lastEventId: string | null;
  /** Reserved for Issue #7 Continuation. Always null in this phase. */
  continuation: null;
};

export const EMPTY_SYNC_STATE: ExecutionSessionSyncState = {
  revision: 0,
  lastEventId: null,
  continuation: null,
};

/** kebab-case agent path segment for `routeAgentRequest` / `useAgent`. */
export const EXECUTION_SESSION_AGENT_NAME = "execution-session-agent";
