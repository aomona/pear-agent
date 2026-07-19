import { z } from "zod";

import { dateSchema } from "./date.js";
import { jsonValueSchema } from "./world-state.js";

export const successCriterionEvaluatorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("human_confirmation") }),
  z.object({ type: z.literal("tool_result") }),
  z.object({ type: z.literal("state_rule") }),
  z.object({ type: z.literal("ai_evaluation") }),
]);

export const successCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  evaluator: successCriterionEvaluatorSchema,
});

export type SuccessCriterion = z.infer<typeof successCriterionSchema>;

export const executionGoalSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    successCriteria: z.array(successCriterionSchema).min(1),
    completionPolicy: z.enum(["automatic", "human_confirmation"]),
    deadline: dateSchema.optional(),
    priority: z.number().optional(),
  })
  .superRefine((goal, context) => {
    const seen = new Set<string>();
    goal.successCriteria.forEach((criterion, index) => {
      if (seen.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate successCriteria id: ${criterion.id}`,
          path: ["successCriteria", index, "id"],
        });
        return;
      }
      seen.add(criterion.id);
    });
  });

export type ExecutionGoal = z.infer<typeof executionGoalSchema>;

export const criterionEvaluationSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(["satisfied", "unsatisfied", "unknown"]),
  // Must stay JSON-safe: repository boundaries clone state with structuredClone.
  evidence: z.array(jsonValueSchema),
  evaluatedAt: dateSchema,
});

export type CriterionEvaluation = z.infer<typeof criterionEvaluationSchema>;

/**
 * Builds the evaluation set used for completion decisions: one latest evaluation
 * per expected criterion ID. History and unknown criteria are ignored here.
 */
export function latestCriterionEvaluations(
  goal: Pick<ExecutionGoal, "successCriteria">,
  evaluationsByCriterionId: Readonly<Record<string, CriterionEvaluation>>,
): CriterionEvaluation[] {
  const latest: CriterionEvaluation[] = [];
  for (const { id } of goal.successCriteria) {
    const evaluation = evaluationsByCriterionId[id];
    if (evaluation) latest.push(evaluation);
  }
  return latest;
}

export function evaluateGoalCompletion(
  goal: Pick<ExecutionGoal, "successCriteria">,
  evaluations: readonly CriterionEvaluation[],
): "satisfied" | "incomplete" {
  const expectedIds = new Set(goal.successCriteria.map(({ id }) => id));
  const evaluatedIds = new Set(evaluations.map(({ criterionId }) => criterionId));
  const isExactEvaluationSet =
    expectedIds.size === goal.successCriteria.length &&
    evaluations.length === expectedIds.size &&
    evaluatedIds.size === evaluations.length &&
    evaluations.every(({ criterionId }) => expectedIds.has(criterionId));

  return isExactEvaluationSet && evaluations.every(({ status }) => status === "satisfied")
    ? "satisfied"
    : "incomplete";
}

/** CE-17: plan.goal must match the requested goal identity and criteria set. */
export type PlanGoalMatch = { ok: true } | { ok: false; reason: string };

export function assertPlanMatchesGoal(
  plan: { goal: ExecutionGoal },
  goal: ExecutionGoal,
): PlanGoalMatch {
  if (plan.goal.id !== goal.id) {
    return { ok: false, reason: `goal id mismatch: plan=${plan.goal.id} requested=${goal.id}` };
  }
  if (plan.goal.completionPolicy !== goal.completionPolicy) {
    return {
      ok: false,
      reason: `completionPolicy mismatch: plan=${plan.goal.completionPolicy} requested=${goal.completionPolicy}`,
    };
  }
  const planCriteria = new Set(plan.goal.successCriteria.map(({ id }) => id));
  const requestedCriteria = new Set(goal.successCriteria.map(({ id }) => id));
  if (planCriteria.size !== requestedCriteria.size) {
    return { ok: false, reason: "successCriteria id set size mismatch" };
  }
  for (const id of requestedCriteria) {
    if (!planCriteria.has(id)) {
      return { ok: false, reason: `missing successCriteria id on plan: ${id}` };
    }
  }
  return { ok: true };
}

/**
 * CE-18: Domain/host evaluates a single criterion against runtime state.
 * Core does not interpret Domain facts; hosts supply this function.
 */
export type GoalEvaluatorContext = {
  goal: ExecutionGoal;
  plan: unknown;
  worldState: unknown;
  stepStates: unknown;
  now?: Date;
};

export type GoalEvaluator = {
  evaluateCriterion(
    criterionId: string,
    context: GoalEvaluatorContext,
  ): CriterionEvaluation | Promise<CriterionEvaluation>;
};

export async function evaluateAllCriteria(
  evaluator: GoalEvaluator,
  context: GoalEvaluatorContext,
): Promise<CriterionEvaluation[]> {
  const results: CriterionEvaluation[] = [];
  for (const { id } of context.goal.successCriteria) {
    results.push(await evaluator.evaluateCriterion(id, context));
  }
  return results;
}
