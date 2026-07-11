import type { ExecutionGoal, ExecutionPlan } from "@pear-agent/core";

import type { PearRequestContext } from "./context.js";

/**
 * Plan generation port. Production hosts wire this to the AI SDK Planner;
 * tests inject a deterministic fixture planner.
 */
export type PlanGeneratorInput = {
  domainId: string;
  goal: ExecutionGoal;
  normalizedInput: unknown;
  context: PearRequestContext;
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
