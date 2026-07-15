import type { PearRequestContext } from "./context.js";

export type PearOperation =
  | { type: "session.create"; domainId: string }
  | { type: "session.read"; sessionId: string }
  | { type: "session.appendEvent"; sessionId: string; eventType: string }
  | { type: "rawInput.put"; sessionId: string }
  | { type: "rawInput.read"; sessionId: string; inputId: string }
  | { type: "normalizedInput.write"; sessionId: string }
  | { type: "normalizedInput.read"; sessionId: string }
  | { type: "voice.lease.acquire"; sessionId: string }
  | { type: "voice.lease.release"; sessionId: string }
  | { type: "voice.lease.read"; sessionId: string }
  | { type: "voice.token"; sessionId: string }
  | { type: "voice.tool"; sessionId: string; toolName: string }
  | { type: "voice.resumeHandle.write"; sessionId: string }
  | { type: "continuation.suspend"; sessionId: string }
  | { type: "continuation.read"; sessionId: string }
  | { type: "continuation.resume"; sessionId: string; continuationId: string }
  | { type: "continuation.complete"; sessionId: string; continuationId: string }
  | { type: "continuation.failResume"; sessionId: string; continuationId: string }
  | { type: "replan.preflight"; sessionId: string }
  | { type: "replan.request"; sessionId: string; mode: "automatic" | "confirm" | "suggest" }
  | { type: "replan.confirm"; sessionId: string; patchId: string }
  | { type: "replan.read"; sessionId: string }
  | { type: "plan.list" }
  | { type: "plan.create"; domainId: string }
  | { type: "plan.read"; planId: string }
  | { type: "plan.update"; planId: string }
  | { type: "plan.source.create"; planId: string }
  | { type: "plan.source.read"; planId: string }
  | { type: "plan.source.delete"; planId: string; sourceId: string }
  | { type: "plan.compile.start"; planId: string }
  | { type: "plan.compile.read"; planId: string; jobId?: string }
  | { type: "plan.compile.cancel"; planId: string; jobId: string }
  | { type: "plan.compile.retry"; planId: string; jobId: string }
  | { type: "plan.clarification.answer"; planId: string; clarificationId: string }
  | { type: "plan.edit.propose"; planId: string }
  | { type: "plan.edit.confirm"; planId: string; proposalId: string };

/**
 * Host-supplied authorization hook. Throw {@link AuthorizationError} (or any
 * error) to deny the operation before side effects run.
 */
export type AuthorizeFn = (
  operation: PearOperation,
  context: PearRequestContext,
) => void | Promise<void>;

export class AuthorizationError extends Error {
  readonly status = 403;

  constructor(message = "Forbidden") {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** Development helper that allows every operation. Do not use in production. */
export const allowAllAuthorize: AuthorizeFn = () => undefined;
