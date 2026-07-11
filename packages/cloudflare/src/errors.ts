/** Session row / materialized state not found in D1. */
export class SessionNotFoundError extends Error {
  readonly status = 404 as const;

  constructor(sessionId: string) {
    super(`Unknown execution session: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

/** Session id already exists (create conflict). */
export class SessionConflictError extends Error {
  readonly status = 409 as const;

  constructor(sessionId: string) {
    super(`Execution session already exists: ${sessionId}`);
    this.name = "SessionConflictError";
  }
}

/** Event id / idempotency key uniqueness conflict that is not a clean duplicate. */
export class EventIdentityConflictError extends Error {
  readonly status = 409 as const;

  constructor(eventId: string, idempotencyKey: string) {
    super(`Event identity conflict for id=${eventId} idempotencyKey=${idempotencyKey}`);
    this.name = "EventIdentityConflictError";
  }
}
