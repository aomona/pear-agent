import {
  createWorldState,
  deriveStepStatuses,
  executionPlanSchema,
  type ExecutionPlan,
  type MaterializedExecutionState,
  type WorldState,
} from "@pear-agent/core";
import { z } from "zod";

export type BuildInitialExecutionStateInput = {
  sessionId: string;
  plan: ExecutionPlan;
  actorIds: readonly string[];
  worldState?: WorldState;
  now?: Date;
};

export function buildInitialExecutionState(
  input: BuildInitialExecutionStateInput,
): MaterializedExecutionState {
  const now = input.now ?? new Date();
  const plan = executionPlanSchema(z.unknown()).parse(input.plan);
  if (input.actorIds.length === 0) {
    throw new Error("Session requires at least one actorId");
  }

  return {
    session: {
      id: input.sessionId,
      planId: plan.id,
      planVersion: plan.version,
      goalId: plan.goal.id,
      status: "not_started",
      actorIds: [...input.actorIds],
      createdAt: now,
      updatedAt: now,
    },
    plan,
    worldState: input.worldState ?? createWorldState({ updatedAt: now }),
    stepStates: deriveStepStatuses(plan.steps, {}),
    timers: {},
    criterionEvaluations: {},
    criterionEvaluationHistory: [],
    appliedEventIds: [],
    appliedIdempotencyKeys: [],
  };
}
