import type { PearRequestContext } from "./context.js";

export type PearOperation =
  | { type: "session.create"; domainId: string }
  | { type: "session.read"; sessionId: string }
  | { type: "session.appendEvent"; sessionId: string; eventType: string }
  | { type: "rawInput.put"; sessionId: string }
  | { type: "rawInput.read"; sessionId: string; inputId: string }
  | { type: "normalizedInput.write"; sessionId: string }
  | { type: "normalizedInput.read"; sessionId: string };

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

export async function runAuthorize(
  authorize: AuthorizeFn,
  operation: PearOperation,
  context: PearRequestContext,
): Promise<void> {
  await authorize(operation, context);
}
