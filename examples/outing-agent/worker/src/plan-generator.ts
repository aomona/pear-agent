import type { PlanGenerator } from "@pear-agent/cloudflare";
import {
  buildOutingPlan,
  outingDomain,
  type OutingNormalizedInput,
} from "@pear-agent/outing-domain-example";

/**
 * Deterministic planner for the outing sample.
 * Hosts can swap this for an AI SDK structured planner later.
 */
export const planGenerator: PlanGenerator = {
  async generatePlan({ domainId, goal, normalizedInput }) {
    if (domainId !== outingDomain.id) {
      throw new Error(`Unknown domain: ${domainId}`);
    }
    const parsed = outingDomain.schemas.normalizedInput.parse(
      normalizedInput,
    ) as OutingNormalizedInput;
    const plan = buildOutingPlan(parsed);
    if (plan.goal.id !== goal.id) {
      throw new Error("Planner goal id must match the requested goal id");
    }
    return plan;
  },
};
