import { z } from "zod";

import { executionGoalSchema, type ExecutionGoal } from "./goal.js";
import { jsonValueSchema } from "./world-state.js";

export const wakeConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("time"), wakeAt: z.iso.datetime({ offset: true }) }),
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

/**
 * Adds the persistence boundary's JSON-safe constraint without changing the
 * inferred output type of a domain schema. Repository state is defensively
 * cloned with `structuredClone`, so arbitrary unknown values (for example
 * functions, symbols, and class instances) cannot be accepted as step data.
 */
function jsonSafeDomainDataSchema<TStepDataSchema extends z.ZodType>(
  domainDataSchema: TStepDataSchema,
): z.ZodType<z.output<TStepDataSchema>, z.input<TStepDataSchema>> {
  return domainDataSchema.superRefine((value, context) => {
    if (!jsonValueSchema.safeParse(value).success) {
      context.addIssue({
        code: "custom",
        message: "domainData must be JSON-safe",
      });
    }
  }) as z.ZodType<z.output<TStepDataSchema>, z.input<TStepDataSchema>>;
}

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
    domainData: jsonSafeDomainDataSchema(domainDataSchema),
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
  const visited = new Set<string>();

  // Iterative DFS: an explicit stack avoids RangeError on deep plans that a
  // recursive traversal would hit as "Maximum call stack size exceeded".
  for (const { id: rootId } of nodes) {
    if (visited.has(rootId)) continue;

    // `enter === true` marks descent into a node; `enter === false` is the
    // post-order visit that pops the node off the current DFS path.
    const stack: { id: string; enter: boolean }[] = [{ id: rootId, enter: true }];
    const onPath = new Set<string>();

    while (stack.length > 0) {
      const frame = stack.pop()!;
      const { id } = frame;

      if (!frame.enter) {
        onPath.delete(id);
        continue;
      }

      if (visited.has(id)) continue;

      visited.add(id);
      onPath.add(id);
      stack.push({ id, enter: false });

      for (const dependencyId of dependencies.get(id) ?? []) {
        if (onPath.has(dependencyId)) return { valid: false, reason: "cycle" };
        if (!visited.has(dependencyId)) stack.push({ id: dependencyId, enter: true });
      }
    }
  }

  return { valid: true };
}
