import { z } from "zod";

import { executionGoalSchema, type ExecutionGoal } from "./goal.js";
import { validatePlanGraph } from "./plan-graph.js";
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

const timerDefinitionsSchema = z.union([z.array(timerDefinitionSchema), z.array(z.unknown())]);

/** CE-03: quantity-bearing resource need (optional; complements requirements[]). */
export const resourceRequirementSchema = z.object({
  resourceId: z.string().min(1),
  quantity: z.number().positive(),
});

export type ResourceRequirement = z.infer<typeof resourceRequirementSchema>;

/** CE-04: relative schedule window from plan t=0. */
export const stepTimelineSchema = z
  .object({
    startOffsetSeconds: z.number().nonnegative(),
    endOffsetSeconds: z.number().nonnegative(),
  })
  .superRefine((value, context) => {
    if (value.endOffsetSeconds < value.startOffsetSeconds) {
      context.addIssue({
        code: "custom",
        message: "timeline.endOffsetSeconds must be at least startOffsetSeconds",
        path: ["endOffsetSeconds"],
      });
    }
  });

export type StepTimeline = z.infer<typeof stepTimelineSchema>;

/** CE-16: concurrent capacity of a resource for scheduling. */
export const resourceCapacitySchema = z.object({
  id: z.string().min(1),
  capacity: z.number().positive(),
  mode: z.enum(["exclusive", "shared"]).optional(),
});

export type ResourceCapacity = z.infer<typeof resourceCapacitySchema>;

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
  /** CE-03: quantity requirements (preferred over requirements[] when present). */
  resourceRequirements?: ResourceRequirement[];
  /** CE-04: relative timeline window. */
  timeline?: StepTimeline;
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
    // The second branch preserves plans written before timers became structured.
    timers: timerDefinitionsSchema,
    domainData: jsonSafeDomainDataSchema(domainDataSchema),
    label: nonEmptyTrimmed(160).optional(),
    summary: nonEmptyTrimmed(280).optional(),
    instructions: nonEmptyTrimmed(2_000).optional(),
    notes: z.array(nonEmptyTrimmed(200)).max(20).optional(),
    resourceRequirements: z.array(resourceRequirementSchema).max(50).optional(),
    timeline: stepTimelineSchema.optional(),
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
        for (const [timerIndex, rawTimer] of step.timers.entries()) {
          const parsedTimer = timerDefinitionSchema.safeParse(rawTimer);
          if (!parsedTimer.success) continue;
          const timer = parsedTimer.data;
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

        if (step.resourceRequirements) {
          const seen = new Set<string>();
          for (const [reqIndex, req] of step.resourceRequirements.entries()) {
            if (seen.has(req.resourceId)) {
              context.addIssue({
                code: "custom",
                message: `Duplicate resourceId in resourceRequirements: ${req.resourceId}`,
                path: ["steps", stepIndex, "resourceRequirements", reqIndex, "resourceId"],
              });
            }
            seen.add(req.resourceId);
          }
        }

        if (step.timeline) {
          const duration = step.timeline.endOffsetSeconds - step.timeline.startOffsetSeconds;
          // Allow small float noise; durations are typically whole seconds.
          if (Math.abs(duration - step.estimatedDurationSeconds) > 0.001) {
            context.addIssue({
              code: "custom",
              message:
                "timeline duration must match estimatedDurationSeconds (end - start === estimated)",
              path: ["steps", stepIndex, "timeline"],
            });
          }
        }
      });
    }) as unknown as z.ZodType<ExecutionPlan<z.output<TStepDataSchema>>>;
}

/** Resolve quantity requirements for scheduling (CE-03). Prefer resourceRequirements when set. */
export function effectiveResourceRequirements(
  step: Pick<ExecutionStep, "requirements" | "resourceRequirements">,
): ResourceRequirement[] {
  const quantities = new Map<string, number>();
  const requirements =
    step.resourceRequirements && step.resourceRequirements.length > 0
      ? step.resourceRequirements
      : step.requirements.map((resourceId) => ({ resourceId, quantity: 1 }));
  for (const requirement of requirements) {
    quantities.set(
      requirement.resourceId,
      (quantities.get(requirement.resourceId) ?? 0) + requirement.quantity,
    );
  }
  return [...quantities].map(([resourceId, quantity]) => ({ resourceId, quantity }));
}

// Graph helpers live in plan-graph.ts; re-exported for a stable public API.
export {
  computeCriticalPathIds,
  estimateCriticalPathDurationSeconds,
  topologicalDepths,
  topologicalOrder,
  validatePlanGraph,
  type PlanGraphNode,
  type PlanGraphValidation,
  type TimedPlanNode,
} from "./plan-graph.js";
