import {
  createPearWorker,
  ExecutionSessionAgent,
  resolvePearContextFromHeader,
} from "@pear-agent/cloudflare";

import { authorize } from "./authorize.js";
import { handleCorsPreflight, withCors } from "./cors.js";
import { planGenerator } from "./plan-generator.js";
import { replanRuntime } from "./replan-runtime.js";

export { ExecutionSessionAgent };

const worker = createPearWorker({
  authorize,
  planGenerator,
  replanRuntime,
  resolveContext: async (request) => {
    try {
      return await resolvePearContextFromHeader(request);
    } catch {
      // Demo default when the React client always sends context; keep a fallback actor.
      return {
        actorId: "demo-user",
        roles: ["owner"],
        claims: {},
      };
    }
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
