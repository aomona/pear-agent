import { outingGoal, outingPlan } from "../../../examples/outing-domain/src/domain.js";

import { allowAllAuthorize, AuthorizationError, type AuthorizeFn } from "./authorize.js";
import { ExecutionSessionAgent } from "./agent/execution-session-agent.js";
import { createStaticPlanGenerator } from "./planner.js";
import { createPearWorker } from "./worker.js";

export { ExecutionSessionAgent };

/**
 * Test/demo Worker entry. Production hosts call {@link createPearWorker} (or
 * {@link createPearApp} + `routeAgentRequest`) with their own authorize + AI SDK
 * PlanGenerator and export ExecutionSessionAgent.
 */
const denyHeader = "x-pear-deny";

const authorize: AuthorizeFn = async (operation, context) => {
  if (context.claims["deny"] === true) {
    throw new AuthorizationError("Denied by test claim");
  }
  // Allow integration tests to force a deny via header-derived claim only.
  await allowAllAuthorize(operation, context);
};

const worker = createPearWorker({
  authorize,
  planGenerator: createStaticPlanGenerator(outingPlan),
  // Integration tests mint tokens without calling Google.
  voiceTokenMinter: async (input) => ({
    token: `test-token-${input.lease.id}`,
    model: "test-model",
  }),
  resolveContext: (request) => {
    const raw = request.headers.get("x-pear-context");
    if (!raw) {
      return {
        actorId: "test-actor",
        roles: ["tester"],
        claims: request.headers.get(denyHeader) === "1" ? { deny: true } : {},
      };
    }
    const parsed = JSON.parse(raw) as {
      actorId: string;
      roles?: string[];
      claims?: Record<string, unknown>;
    };
    return {
      actorId: parsed.actorId,
      roles: parsed.roles ?? [],
      claims: {
        ...parsed.claims,
        ...(request.headers.get(denyHeader) === "1" ? { deny: true } : {}),
      },
    };
  },
});

// Keep goal import live for type-level coupling to the sample domain.
void outingGoal;

export default {
  fetch: worker.fetch,
};
