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

/** CE-02: structured timer definitions on a Step (not runtime ExecutionTimer state). */
export const timerDefinitionSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(160).optional(),
  durationSeconds: z.number().nonnegative(),
  autoStart: z.boolean().optional(),
  linkedStepId: z.string().min(1).optional(),
});

export type TimerDefinition = z.infer<typeof timerDefinitionSchema>;

const nonEmptyTrimmed = (max: number) => z.string().trim().min(1).max(max);

export type ExecutionStep<TStepData = unknown> = {
  id: string;
  executor: StepExecutor;
  after: string[];
  requirements: string[];
  estimatedDurationSeconds: number;
  timers: TimerDefinition[];
  domainData: TStepData;
  /** CE-01: short human-facing title for UI / Voice. */
  label?: string;
  /** CE-01: one-line summary. */
  summary?: string;
  /** CE-01: detailed instructions for the actor. */
  instructions?: string;
  /** CE-01: optional notes (tips, cautions). */
  notes?: string[];
};

export type ExecutionPlan<TStepData = unknown> = {
  id: string;
  version: number;
  goal: ExecutionGoal;
  steps: ExecutionStep<TStepData>[];
  /** CE-07: human-facing plan title. */
  title?: string;
  /** CE-07: JSON-safe bag for Domain / host metadata. */
  metadata?: Record<string, import("./world-state.js").JsonValue>;
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
    timers: z.array(timerDefinitionSchema),
    domainData: jsonSafeDomainDataSchema(domainDataSchema),
    label: nonEmptyTrimmed(160).optional(),
    summary: nonEmptyTrimmed(280).optional(),
    instructions: nonEmptyTrimmed(2_000).optional(),
    notes: z.array(nonEmptyTrimmed(200)).max(20).optional(),
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
      title: nonEmptyTrimmed(160).optional(),
      metadata: z.record(z.string(), jsonValueSchema).optional(),
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

      const stepIds = new Set(steps.map(({ id }) => id));
      const timerIds = new Set<string>();
      steps.forEach((step, stepIndex) => {
        for (const [timerIndex, timer] of step.timers.entries()) {
          if (timerIds.has(timer.id)) {
            context.addIssue({
              code: "custom",
              message: `Duplicate timer definition id: ${timer.id}`,
              path: ["steps", stepIndex, "timers", timerIndex, "id"],
            });
          }
          timerIds.add(timer.id);
          if (timer.linkedStepId !== undefined && !stepIds.has(timer.linkedStepId)) {
            context.addIssue({
              code: "custom",
              message: `Timer linkedStepId not found: ${timer.linkedStepId}`,
              path: ["steps", stepIndex, "timers", timerIndex, "linkedStepId"],
            });
          }
        }
      });
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

/** Longest-path duration through the DAG (critical path length in seconds). */
export function estimateCriticalPathDurationSeconds(
  steps: readonly Pick<ExecutionStep, "id" | "after" | "estimatedDurationSeconds">[],
): number {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const memo = new Map<string, number>();

  const dfs = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const step = byId.get(id);
    if (!step) return 0;
    const depMax = step.after.length === 0 ? 0 : Math.max(...step.after.map((depId) => dfs(depId)));
    const total = depMax + step.estimatedDurationSeconds;
    memo.set(id, total);
    return total;
  };

  let max = 0;
  for (const step of steps) {
    max = Math.max(max, dfs(step.id));
  }
  return max;
}

/** Step ids on one critical path (first max predecessor each time). */
export function computeCriticalPathIds(
  steps: readonly Pick<ExecutionStep, "id" | "after" | "estimatedDurationSeconds">[],
): string[] {
  if (steps.length === 0) return [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const best = new Map<string, number>();

  const pathLength = (id: string): number => {
    const cached = best.get(id);
    if (cached !== undefined) return cached;
    const step = byId.get(id);
    if (!step) return 0;
    const depMax =
      step.after.length === 0 ? 0 : Math.max(...step.after.map((depId) => pathLength(depId)));
    const total = depMax + step.estimatedDurationSeconds;
    best.set(id, total);
    return total;
  };

  for (const step of steps) pathLength(step.id);

  let endId = steps[0]!.id;
  let endLen = best.get(endId) ?? 0;
  for (const step of steps) {
    const len = best.get(step.id) ?? 0;
    if (len > endLen) {
      endId = step.id;
      endLen = len;
    }
  }

  const path: string[] = [];
  let current: string | undefined = endId;
  while (current) {
    path.push(current);
    const step = byId.get(current);
    if (!step || step.after.length === 0) break;
    let bestDep = step.after[0]!;
    let bestDepLen = best.get(bestDep) ?? 0;
    for (const depId of step.after) {
      const len = best.get(depId) ?? 0;
      if (len > bestDepLen) {
        bestDep = depId;
        bestDepLen = len;
      }
    }
    current = bestDep;
  }
  path.reverse();
  return path;
}
