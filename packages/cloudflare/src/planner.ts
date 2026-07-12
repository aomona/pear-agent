import {
  createStaticPlanGenerator,
  type ExecutionPlan,
  type PlanGenerator as CorePlanGenerator,
  type PlanGeneratorInput as CorePlanGeneratorInput,
} from "@pear-agent/core";

import type { PearRequestContext } from "./context.js";

export { createStaticPlanGenerator };

/**
 * Cloudflare PlanGenerator: Core port with required PEAR request context.
 * Static generators from Core are structurally assignable (they ignore context).
 */
export type PlanGeneratorInput = Omit<CorePlanGeneratorInput, "context"> & {
  context: PearRequestContext;
};

export type PlanGenerator = {
  generatePlan(input: PlanGeneratorInput): Promise<ExecutionPlan>;
};

export type { CorePlanGenerator, ExecutionPlan };
