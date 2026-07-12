import {
  createPearWorker,
  ExecutionSessionAgent,
  PEAR_CONTEXT_HEADER,
  resolvePearContextFromHeader,
} from "@pear-agent/cloudflare";

import { authorize } from "./authorize.js";
import { handleCorsPreflight, withCors } from "./cors.js";
import { planGenerator } from "./plan-generator.js";
import { replanRuntime } from "./replan-runtime.js";

export { ExecutionSessionAgent };

const DEMO_CONTEXT = {
  actorId: "demo-user",
  roles: ["owner"] as string[],
  claims: {} as Record<string, unknown>,
};

const worker = createPearWorker({
  authorize,
  planGenerator,
  replanRuntime,
  resolveContext: async (request) => {
    // Demo only: missing header → default actor. Malformed header still fails closed.
    if (!request.headers.get(PEAR_CONTEXT_HEADER)) {
      return DEMO_CONTEXT;
    }
    return resolvePearContextFromHeader(request);
  },
});

export default {
  async fetch(request: Request, env: Parameters<typeof worker.fetch>[1], ctx: ExecutionContext) {
    const preflight = handleCorsPreflight(request);
    if (preflight) return preflight;

    const response = await worker.fetch(request, env, ctx);
    // WebSocket upgrades must not be re-wrapped (body/status semantics).
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return response;
    }
    return withCors(request, response);
  },
};
