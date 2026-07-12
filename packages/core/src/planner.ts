import type { ExecutionGoal } from "./goal.js";
import type { ExecutionPlan } from "./plan.js";

/**
 * CE-08: Plan generation port (host implements with AI SDK or fixtures).
 * Cloudflare re-exports this type and keeps its own context-bearing wrapper.
 */
export type PlanGeneratorInput = {
  domainId: string;
  goal: ExecutionGoal;
  normalizedInput: unknown;
  /** Opaque host auth/request context (typed at Adapter boundary). */
  context?: unknown;
  /** Present when raw input was stored before planning. */
  rawInputId?: string;
};

export type PlanGenerator = {
  generatePlan(input: PlanGeneratorInput): Promise<ExecutionPlan>;
};

export function createStaticPlanGenerator(plan: ExecutionPlan): PlanGenerator {
  return {
    async generatePlan() {
      return plan;
    },
  };
}
