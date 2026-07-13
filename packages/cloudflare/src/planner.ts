import {
  createStaticPlanGenerator,
  type ExecutionPlan,
  type PlanGenerator as CorePlanGenerator,
  type PlanGeneratorInput as CorePlanGeneratorInput,
} from "@pear-agent/core";

import type { PearRequestContext } from "./context.js";
import type { PearEnv } from "./env.js";

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

/** Options shared by session create and plan-library generate. */
export type PlanGeneratorOptions = {
  planGenerator: PlanGenerator;
  /**
   * Per-request PlanGenerator (e.g. needs `env.GEMINI_API_KEY`).
   * When set, used instead of {@link planGenerator}.
   */
  createPlanGenerator?: (env: PearEnv) => PlanGenerator;
};

/**
 * Prefer env-backed factory when present; otherwise the static generator.
 * Single place used by both HTTP session routes and plan library.
 */
export function resolvePlanGenerator(options: PlanGeneratorOptions, env: PearEnv): PlanGenerator {
  return options.createPlanGenerator?.(env) ?? options.planGenerator;
}

export type { CorePlanGenerator, ExecutionPlan };
