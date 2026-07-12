import {
  createStaticPlanGenerator,
  type ExecutionGoal,
  type ExecutionPlan,
  type PlanGenerator as CorePlanGenerator,
  type PlanGeneratorInput as CorePlanGeneratorInput,
} from "@pear-agent/core";

import type { PearRequestContext } from "./context.js";

export { createStaticPlanGenerator };

/**
 * Cloudflare PlanGenerator: Core port + typed PEAR request context.
 * Hosts inject AI SDK implementations; tests use {@link createStaticPlanGenerator}.
 */
export type PlanGeneratorInput = Omit<CorePlanGeneratorInput, "context"> & {
  context: PearRequestContext;
};

export type PlanGenerator = {
  generatePlan(input: PlanGeneratorInput): Promise<ExecutionPlan>;
};

/** Ensure static fixture generators satisfy the Cloudflare-typed port. */
export function asPearPlanGenerator(generator: CorePlanGenerator): PlanGenerator {
  return {
    async generatePlan(input) {
      return generator.generatePlan(input);
    },
  };
}

export type { ExecutionGoal, ExecutionPlan };
