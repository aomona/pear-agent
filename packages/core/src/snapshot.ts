import { z } from "zod";

import { runtimeEventSchema, type RuntimeEvent } from "./event.js";
import { executionPlanSchema, type ExecutionPlan } from "./plan.js";
import {
  materializedExecutionStateSchema,
  type MaterializedExecutionState,
} from "./execution-state.js";
import { executionSessionSchema } from "./session.js";
import { executionTimerSchema } from "./timer.js";
import { stepStatesSchema } from "./step-state.js";
import { worldStateSchema } from "./world-state.js";

/** The read model used when resuming or presenting an execution session. */
export const runtimeSnapshotSchema = z.object({
  plan: executionPlanSchema(z.unknown()),
  session: executionSessionSchema,
  worldState: worldStateSchema,
  stepStates: stepStatesSchema,
  activeTimers: z.array(executionTimerSchema),
  recentEvents: z.array(runtimeEventSchema),
  readyStepIds: z.array(z.string().min(1)),
  activeStepIds: z.array(z.string().min(1)),
  blockedStepIds: z.array(z.string().min(1)),
  generatedAt: z.date(),
});

export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;

export type CreateRuntimeSnapshotInput<TStepData = unknown> = {
  plan: ExecutionPlan<TStepData>;
  state: MaterializedExecutionState;
  recentEvents: readonly RuntimeEvent[];
  generatedAt?: Date;
};

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
}: CreateRuntimeSnapshotInput<TStepData>): RuntimeSnapshot {
  const planStepIds = new Set(plan.steps.map(({ id }) => id));
  const stepStates = Object.fromEntries(
    plan.steps
      .filter(({ id }) => state.stepStates[id] !== undefined)
      .map(({ id }) => [id, state.stepStates[id]!]),
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
    plan,
    session: state.session,
    worldState: state.worldState,
    stepStates,
    activeTimers: Object.values(state.timers).filter(({ status }) => status === "running"),
    recentEvents: [...recentEvents],
    readyStepIds,
    activeStepIds,
    blockedStepIds,
    generatedAt,
  });
}

// Keep these imports part of this module's public schema boundary. This also
// ensures consumers can validate a materialized state before snapshotting.
export { materializedExecutionStateSchema };
