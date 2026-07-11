import { z } from "zod";

import { executionGoalSchema, type ExecutionGoal } from "./goal.js";

export const wakeConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("time"), wakeAt: z.string().min(1) }),
  z.object({ type: z.literal("event"), eventType: z.string().min(1) }),
]);

export type WakeCondition = z.infer<typeof wakeConditionSchema>;

export const stepExecutorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("human") }),
  z.object({ type: z.literal("agent"), capabilityId: z.string().min(1) }),
  z.object({ type: z.literal("wait"), wakeCondition: wakeConditionSchema }),
]);

export type StepExecutor = z.infer<typeof stepExecutorSchema>;

export type ExecutionStep<TStepData = unknown> = {
  id: string;
  executor: StepExecutor;
  after: string[];
  requirements: string[];
  estimatedDurationSeconds: number;
  timers: unknown[];
  domainData: TStepData;
};

export type ExecutionPlan<TStepData = unknown> = {
  id: string;
  version: number;
  goal: ExecutionGoal;
  steps: ExecutionStep<TStepData>[];
};

export function executionStepSchema<TStepDataSchema extends z.ZodType>(
  domainDataSchema: TStepDataSchema,
): z.ZodType<ExecutionStep<z.output<TStepDataSchema>>> {
  return z.object({
    id: z.string().min(1),
    executor: stepExecutorSchema,
    after: z.array(z.string().min(1)),
    requirements: z.array(z.string().min(1)),
    estimatedDurationSeconds: z.number().nonnegative(),
    timers: z.array(z.unknown()),
    domainData: domainDataSchema,
  }) as unknown as z.ZodType<ExecutionStep<z.output<TStepDataSchema>>>;
}

export function executionPlanSchema<TStepDataSchema extends z.ZodType>(
  domainDataSchema: TStepDataSchema,
): z.ZodType<ExecutionPlan<z.output<TStepDataSchema>>> {
  return z
    .object({
      id: z.string().min(1),
      version: z.number().int().positive(),
      goal: executionGoalSchema,
      steps: z.array(executionStepSchema(domainDataSchema)),
    })
    .superRefine(({ steps }, context) => {
      const validation = validatePlanGraph(steps);
      if (!validation.valid) {
        context.addIssue({
          code: "custom",
          message: `Invalid plan graph: ${validation.reason}`,
          path: ["steps"],
        });
      }
    }) as unknown as z.ZodType<ExecutionPlan<z.output<TStepDataSchema>>>;
}

export type PlanGraphNode = {
  id: string;
  after: readonly string[];
};

export type PlanGraphValidation =
  | { valid: true }
  | { valid: false; reason: "duplicate_id" | "missing_dependency" | "cycle" };

export function validatePlanGraph(nodes: readonly PlanGraphNode[]): PlanGraphValidation {
  const ids = new Set<string>();
  for (const { id } of nodes) {
    if (ids.has(id)) return { valid: false, reason: "duplicate_id" };
    ids.add(id);
  }

  for (const { after } of nodes) {
    if (after.some((dependencyId) => !ids.has(dependencyId))) {
      return { valid: false, reason: "missing_dependency" };
    }
  }

  const dependencies = new Map(nodes.map(({ id, after }) => [id, after]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;

    visiting.add(id);
    for (const dependencyId of dependencies.get(id) ?? []) {
      if (hasCycle(dependencyId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return nodes.some(({ id }) => hasCycle(id)) ? { valid: false, reason: "cycle" } : { valid: true };
}
