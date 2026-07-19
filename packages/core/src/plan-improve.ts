import type { ExecutionGoal } from "./goal.js";
import type { ExecutionPlan } from "./plan.js";
import type { PlanPatch } from "./replan.js";

/**
 * CE-09: pre-execution plan improvement (host implements with AI SDK).
 * Distinct from runtime partial replan (`PlanPatch` activation path).
 */
export type PlanImproveInput = {
  domainId: string;
  basePlan: ExecutionPlan;
  goal: ExecutionGoal;
  request: string;
  normalizedInput?: unknown;
  constraints?: unknown;
  context?: unknown;
};

export type PlanImproveResult =
  | { kind: "full"; plan: ExecutionPlan }
  | { kind: "patch"; patch: PlanPatch; plan: ExecutionPlan };

export type PlanImprover = {
  improve(input: PlanImproveInput): Promise<PlanImproveResult>;
};

/** Test helper: returns the base plan unchanged (or a provided next plan). */
export function createStaticPlanImprover(
  next?: ExecutionPlan | ((input: PlanImproveInput) => ExecutionPlan),
): PlanImprover {
  return {
    async improve(input) {
      const plan = typeof next === "function" ? next(input) : (next ?? input.basePlan);
      return { kind: "full", plan };
    },
  };
}
