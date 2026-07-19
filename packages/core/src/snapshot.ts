import { z } from "zod";

import { executionContinuationSchema, type ExecutionContinuation } from "./continuation.js";
import { planChangeSchema, type PlanChange } from "./replan.js";
import { dateSchema } from "./date.js";
import { runtimeEventSchema, type RuntimeEvent } from "./event.js";
import { executionPlanSchema, type ExecutionPlan } from "./plan.js";
import {
  materializedExecutionStateSchema,
  type MaterializedExecutionState,
} from "./execution-state.js";
import { executionSessionSchema } from "./session.js";
import { runningExecutionTimerSchema } from "./timer.js";
import { stepStatesSchema } from "./step-state.js";
import { worldStateSchema } from "./world-state.js";

/** The read model used when resuming or presenting an execution session. */
export const runtimeSnapshotSchema = z.object({
  plan: executionPlanSchema(z.unknown()),
  session: executionSessionSchema,
  worldState: worldStateSchema,
  stepStates: stepStatesSchema,
  activeTimers: z.array(runningExecutionTimerSchema),
  recentEvents: z.array(runtimeEventSchema),
  readyStepIds: z.array(z.string().min(1)),
  activeStepIds: z.array(z.string().min(1)),
  blockedStepIds: z.array(z.string().min(1)),
  continuation: executionContinuationSchema.nullable().default(null),
  latestPlanChange: planChangeSchema.nullable().default(null),
  generatedAt: dateSchema,
});

export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;

export type CreateRuntimeSnapshotInput<TStepData = unknown> = {
  plan: ExecutionPlan<TStepData>;
  state: MaterializedExecutionState;
  recentEvents: readonly RuntimeEvent[];
  generatedAt?: Date;
  continuation?: ExecutionContinuation | null;
  latestPlanChange?: PlanChange | null;
};

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

/**
 * Builds a snapshot without mutating the materialized state or event log.
 * Step state keys are deliberately projected through the plan so stale keys
 * from a migrated state cannot leak into the public read model.
 */
export function createRuntimeSnapshot<TStepData = unknown>({
  plan,
  state,
  recentEvents,
  generatedAt = new Date(),
  continuation = null,
  latestPlanChange = null,
}: CreateRuntimeSnapshotInput<TStepData>): RuntimeSnapshot {
  const parsedPlan = executionPlanSchema(z.unknown()).parse(plan);
  const parsedState = materializedExecutionStateSchema.parse(state);
  if (
    parsedPlan.id !== parsedState.session.planId ||
    parsedPlan.version !== parsedState.session.planVersion ||
    parsedState.plan.id !== parsedPlan.id ||
    parsedState.plan.version !== parsedPlan.version
  ) {
    throw new Error("Plan identity/version does not match execution state session");
  }
  if (!structurallyEqual(parsedPlan, parsedState.plan)) {
    throw new Error("Supplied plan does not match execution state plan");
  }
  if (parsedState.session.goalId !== parsedPlan.goal.id) {
    throw new Error("Session goal does not match execution plan goal");
  }

  const parsedRecentEvents = recentEvents.map((event) => runtimeEventSchema.parse(event));
  if (parsedRecentEvents.some(({ sessionId }) => sessionId !== parsedState.session.id)) {
    throw new Error("Recent event does not belong to execution session");
  }

  const planStepIds = new Set(parsedPlan.steps.map(({ id }) => id));
  const stepStates = Object.fromEntries(
    parsedPlan.steps
      .filter(({ id }) => parsedState.stepStates[id] !== undefined)
      .map(({ id }) => [id, parsedState.stepStates[id]!]),
  );

  const readyStepIds: string[] = [];
  const activeStepIds: string[] = [];
  const blockedStepIds: string[] = [];
  for (const [stepId, stepState] of Object.entries(stepStates)) {
    if (!planStepIds.has(stepId)) continue;
    if (stepState.status === "ready") readyStepIds.push(stepId);
    if (stepState.status === "active") activeStepIds.push(stepId);
    if (stepState.status === "blocked") blockedStepIds.push(stepId);
  }

  return runtimeSnapshotSchema.parse({
    plan: parsedPlan,
    session: parsedState.session,
    worldState: parsedState.worldState,
    stepStates,
    activeTimers: Object.values(parsedState.timers).filter(({ status }) => status === "running"),
    recentEvents: parsedRecentEvents,
    readyStepIds,
    activeStepIds,
    blockedStepIds,
    continuation,
    latestPlanChange,
    generatedAt,
  });
}
