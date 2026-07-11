import { z } from "zod";

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

export const executionGoalSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  successCriteria: z.array(successCriterionSchema).min(1),
  completionPolicy: z.enum(["automatic", "human_confirmation"]),
  deadline: z.date().optional(),
  priority: z.number().optional(),
});

export type ExecutionGoal = z.infer<typeof executionGoalSchema>;

export const criterionEvaluationSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(["satisfied", "unsatisfied", "unknown"]),
  evidence: z.array(z.unknown()),
  evaluatedAt: z.date(),
});

export type CriterionEvaluation = z.infer<typeof criterionEvaluationSchema>;

export function evaluateGoalCompletion(
  evaluations: readonly CriterionEvaluation[],
): "satisfied" | "incomplete" {
  return evaluations.length > 0 && evaluations.every(({ status }) => status === "satisfied")
    ? "satisfied"
    : "incomplete";
}
