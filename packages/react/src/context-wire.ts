import type { PearClientContext } from "./types.js";

/** HTTP header used for PEAR request context (matches cloudflare adapter). */
export const PEAR_CONTEXT_HEADER = "x-pear-context";

/** Query key used for Agent WebSocket auth (must match `@pear-agent/cloudflare`). */
export const PEAR_CONTEXT_QUERY_KEY = "pearContext";

/**
 * Serialize host auth context for HTTP headers or Agent WebSocket query params.
 */
export function serializePearClientContext(context: PearClientContext): string {
  return JSON.stringify({
    actorId: context.actorId,
    roles: context.roles ?? [],
    claims: context.claims ?? {},
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
  });
}
