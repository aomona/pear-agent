import { routeAgentRequest } from "agents";

import { AuthorizationError, type AuthorizeFn } from "./authorize.js";
import {
  PearContextError,
  parsePearRequestContext,
  resolvePearContextFromHeader,
  type PearRequestContext,
} from "./context.js";
import type { PearEnv } from "./env.js";
import { createPearApp, type CreatePearAppOptions, type PearApp } from "./http/app.js";

/** Query key for Agent WebSocket auth (must match `@pear-agent/react`). */
export const PEAR_CONTEXT_QUERY_KEY = "pearContext";

export type PearWorker = {
  fetch(request: Request, env: PearEnv, ctx: ExecutionContext): Promise<Response>;
  /** Hono app (HTTP API only; agent WebSockets are handled by {@link fetch}). */
  app: PearApp;
};

/**
 * Resolve PEAR context for Agent WebSocket upgrades.
 * Prefers `?pearContext=` (JSON) then falls back to the HTTP header resolver.
 */
export async function resolveAgentConnectContext(
  request: Request,
  resolveContext: (request: Request) => PearRequestContext | Promise<PearRequestContext>,
): Promise<PearRequestContext> {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get(PEAR_CONTEXT_QUERY_KEY);
  if (fromQuery) {
    try {
      return parsePearRequestContext(JSON.parse(fromQuery));
    } catch {
      throw new PearContextError("Invalid pearContext query parameter");
    }
  }
  return resolveContext(request);
}

/**
 * Extract session id from `/agents/execution-session-agent/:sessionId` (and variants).
 */
export function sessionIdFromAgentRequest(request: Request): string | null {
  const path = new URL(request.url).pathname;
  const match = path.match(/\/agents\/[^/]+\/([^/]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Host Worker entry that serves both:
 * - PEAR HTTP API (`createPearApp`)
 * - Agent WebSocket / HTTP routes (`/agents/execution-session-agent/:sessionId`)
 *
 * Prefer this over exporting `createPearApp(...).fetch` alone when React clients
 * subscribe via `agents/client` / `agents/react`.
 *
 * WebSocket connections are authorized with the same `authorize` hook as
 * `session.read` before the Agent wakes.
 */
export function createPearWorker(options: CreatePearAppOptions): PearWorker {
  const app = createPearApp(options);
  const resolveContext = options.resolveContext ?? resolvePearContextFromHeader;
  const authorize: AuthorizeFn = options.authorize;

  return {
    app,
    async fetch(request, env, ctx) {
      const agentResponse = await routeAgentRequest(request, env, {
        onBeforeConnect: async (req) => {
          try {
            const sessionId = sessionIdFromAgentRequest(req);
            if (!sessionId) {
              return new Response(JSON.stringify({ error: "Missing agent session id" }), {
                status: 400,
                headers: { "content-type": "application/json" },
              });
            }
            const context = await resolveAgentConnectContext(req, resolveContext);
            await authorize({ type: "session.read", sessionId }, context);
            return undefined;
          } catch (error) {
            if (error instanceof AuthorizationError) {
              return new Response(JSON.stringify({ error: error.message }), {
                status: error.status,
                headers: { "content-type": "application/json" },
              });
            }
            if (error instanceof PearContextError) {
              return new Response(JSON.stringify({ error: error.message }), {
                status: error.status,
                headers: { "content-type": "application/json" },
              });
            }
            const message = error instanceof Error ? error.message : "Unauthorized";
            return new Response(JSON.stringify({ error: message }), {
              status: 401,
              headers: { "content-type": "application/json" },
            });
          }
        },
      });
      if (agentResponse !== null) {
        return agentResponse;
      }
      return app.fetch(request, env, ctx);
    },
  };
}
