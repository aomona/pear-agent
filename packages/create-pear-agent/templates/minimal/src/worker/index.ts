import { ExecutionSessionAgent, allowAllAuthorize, createPearWorker } from "@pear-agent/cloudflare";
import { executionGoalSchema } from "@pear-agent/core";

import { starterDomain, starterNormalizedInputSchema } from "../domain/domain.js";
import { buildStarterPlan } from "../domain/plan.js";

export { ExecutionSessionAgent };

const worker = createPearWorker({
  // Replace this development policy with your host application's authorization.
  authorize: allowAllAuthorize,
  planGenerator: {
    async generatePlan(input) {
      return buildStarterPlan(
        executionGoalSchema.parse(input.goal),
        starterNormalizedInputSchema.parse(input.normalizedInput),
      );
    },
  },
  planLibrary: {
    async normalizeDomainInput({ domainId, input }) {
      if (domainId !== starterDomain.id) {
        throw new Error(`Unknown domain: ${domainId}`);
      }
      return starterDomain.normalizeInput(starterDomain.schemas.input.parse(input));
    },
  },
});

export default worker;
