import { routeAgentRequest } from "agents";

import type { PearEnv } from "./env.js";
import { createPearApp, type CreatePearAppOptions, type PearApp } from "./http/app.js";

export type PearWorker = {
  fetch(request: Request, env: PearEnv, ctx: ExecutionContext): Promise<Response>;
  /** Hono app (HTTP API only; agent WebSockets are handled by {@link fetch}). */
  app: PearApp;
};

/**
 * Host Worker entry that serves both:
 * - PEAR HTTP API (`createPearApp`)
 * - Agent WebSocket / HTTP routes (`/agents/execution-session-agent/:sessionId`)
 *
 * Prefer this over exporting `createPearApp(...).fetch` alone when React clients
 * subscribe via `agents/react` `useAgent`.
 */
export function createPearWorker(options: CreatePearAppOptions): PearWorker {
  const app = createPearApp(options);

  return {
    app,
    async fetch(request, env, ctx) {
      const agentResponse = await routeAgentRequest(request, env);
      if (agentResponse !== null) {
        return agentResponse;
      }
      return app.fetch(request, env, ctx);
    },
  };
}
