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

/** Another active voice lease already exists for the session. */
export class VoiceLeaseConflictError extends Error {
  readonly status = 409 as const;

  constructor(sessionId: string, holderActorId?: string) {
    const holder = holderActorId ? ` (held by ${holderActorId})` : "";
    super(`Voice lease already active for session ${sessionId}${holder}`);
    this.name = "VoiceLeaseConflictError";
  }
}

/** No active voice lease (or not held by the requesting actor). */
export class VoiceLeaseNotFoundError extends Error {
  readonly status = 404 as const;

  constructor(sessionId: string) {
    super(`No active voice lease for session ${sessionId}`);
    this.name = "VoiceLeaseNotFoundError";
  }
}

/** Gemini API key missing or token mint unavailable. */
export class VoiceTokenUnavailableError extends Error {
  readonly status = 503 as const;

  constructor(message = "Voice token minting is unavailable") {
    super(message);
    this.name = "VoiceTokenUnavailableError";
  }
}
