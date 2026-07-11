import { z } from "zod";

export const pearRequestContextSchema = z.object({
  actorId: z.string().min(1),
  roles: z.array(z.string().min(1)).default([]),
  claims: z.record(z.string(), z.unknown()).default({}),
  requestId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

export type PearRequestContext = z.infer<typeof pearRequestContextSchema>;

export function parsePearRequestContext(value: unknown): PearRequestContext {
  return pearRequestContextSchema.parse(value);
}

/** Default header used when host apps forward authenticated context as JSON. */
export const PEAR_CONTEXT_HEADER = "x-pear-context";

/**
 * Reads `x-pear-context` as a JSON object (optionally base64-encoded).
 * Host apps may replace this with JWT-derived context via `resolveContext`.
 */
export function resolvePearContextFromHeader(request: Request): PearRequestContext {
  const raw = request.headers.get(PEAR_CONTEXT_HEADER);
  if (!raw) {
    throw new PearContextError("Missing authentication context header");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(atob(raw));
    } catch {
      throw new PearContextError("Invalid authentication context header");
    }
  }

  try {
    return parsePearRequestContext(parsed);
  } catch {
    throw new PearContextError("Invalid authentication context payload");
  }
}

export class PearContextError extends Error {
  readonly status = 401;

  constructor(message: string) {
    super(message);
    this.name = "PearContextError";
  }
}
