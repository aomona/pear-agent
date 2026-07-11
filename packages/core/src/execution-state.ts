import { z } from "zod";

import {
  criterionEvaluationSchema,
  evaluateGoalCompletion,
  latestCriterionEvaluations,
} from "./goal.js";
import { executionPlanSchema } from "./plan.js";
import { type RuntimeEvent } from "./event.js";
import { executionSessionSchema } from "./session.js";
import { deriveStepStatuses, stepStatesSchema, transitionStep } from "./step-state.js";
import { worldStateSchema } from "./world-state.js";
import { executionTimerSchema } from "./timer.js";

const TERMINAL_SESSION_STATUSES = new Set(["completed", "cancelled"]);

export const materializedExecutionStateSchema = z.object({
  session: executionSessionSchema,
  plan: executionPlanSchema(z.unknown()),
  worldState: worldStateSchema,
  stepStates: stepStatesSchema,
  timers: z.record(z.string(), executionTimerSchema),
  // Latest materialized evaluation by criterion ID (projection for reads and
  // completion). History is audit-only; completion never consults the full
  // append-only list, so re-evaluation can still complete a goal.
  criterionEvaluations: z.record(z.string(), criterionEvaluationSchema),
  criterionEvaluationHistory: z.array(criterionEvaluationSchema),
  lastAppliedEventAt: z.date().optional(),
  appliedEventIds: z.array(z.string().min(1)),
  appliedIdempotencyKeys: z.array(z.string().min(1)),
});

export type MaterializedExecutionState = z.infer<typeof materializedExecutionStateSchema>;

export function applyRuntimeEvent(
  state: Readonly<MaterializedExecutionState>,
  event: RuntimeEvent,
): MaterializedExecutionState {
  const appliedEventIds = new Set(state.appliedEventIds);
  const appliedIdempotencyKeys = new Set(state.appliedIdempotencyKeys);
  if (appliedEventIds.has(event.id) || appliedIdempotencyKeys.has(event.idempotencyKey)) {
    return state;
  }

  if (event.sessionId !== state.session.id) {
    throw new Error(
      `Event session ${event.sessionId} does not match state session ${state.session.id}`,
    );
  }

  if (TERMINAL_SESSION_STATUSES.has(state.session.status)) {
    throw new Error(`Cannot apply event to ${state.session.status} session`);
  }

  let stepStates = state.stepStates;
  let timers = state.timers;
  let criterionEvaluations = state.criterionEvaluations;
  let criterionEvaluationHistory = state.criterionEvaluationHistory;
  let worldState = state.worldState;
  let session = state.session;
  if (
    event.type === "step_started" ||
    event.type === "step_completed" ||
    event.type === "step_failed"
  ) {
    const { stepId } = event.payload;
    const current = state.stepStates[stepId];
    if (!current) throw new Error(`Unknown step: ${stepId}`);
    const nextStatus =
      event.type === "step_started"
        ? "active"
        : event.type === "step_completed"
          ? "completed"
          : "failed";
    const afterTransition = {
      ...state.stepStates,
      [stepId]: transitionStep(current, nextStatus),
    };
    // Overlay readiness for plan steps so dependents leave blocked when deps complete.
    stepStates = {
      ...afterTransition,
      ...deriveStepStatuses(state.plan.steps, afterTransition),
    };
  }

  if (event.type === "timer_started") {
    const { timerId, durationSeconds } = event.payload;
    const existing = state.timers[timerId];
    if (existing && existing.status !== "paused") {
      throw new Error(`Invalid timer transition: ${existing.status} -> running`);
    }
    if (!existing && durationSeconds === undefined) {
      throw new Error(`Timer ${timerId} requires durationSeconds when first started`);
    }
    const remainingSeconds = existing?.remainingSeconds ?? durationSeconds!;
    timers = {
      ...state.timers,
      [timerId]: {
        id: timerId,
        status: "running",
        durationSeconds: existing?.durationSeconds ?? durationSeconds!,
        remainingSeconds,
        startedAt: existing?.startedAt ?? event.occurredAt,
        endsAt: new Date(event.occurredAt.getTime() + remainingSeconds * 1000),
      },
    };
  }

  if (event.type === "timer_paused") {
    const { timerId } = event.payload;
    const existing = state.timers[timerId];
    if (!existing) throw new Error(`Unknown timer: ${timerId}`);
    if (existing.status !== "running") {
      throw new Error(`Invalid timer transition: ${existing.status} -> paused`);
    }
    const remainingSeconds = Math.max(
      0,
      Math.ceil(
        ((existing.endsAt ?? event.occurredAt).getTime() - event.occurredAt.getTime()) / 1000,
      ),
    );
    timers = {
      ...state.timers,
      [timerId]: { ...existing, status: "paused", remainingSeconds, endsAt: undefined },
    };
  }

  if (event.type === "timer_completed") {
    const { timerId } = event.payload;
    const existing = state.timers[timerId];
    if (!existing) throw new Error(`Unknown timer: ${timerId}`);
    if (existing.status !== "running" && existing.status !== "paused") {
      throw new Error(`Invalid timer transition: ${existing.status} -> completed`);
    }
    timers = {
      ...state.timers,
      [timerId]: {
        ...existing,
        status: "completed",
        remainingSeconds: 0,
        endsAt: event.occurredAt,
      },
    };
  }

  if (event.type === "timer_cancelled") {
    const { timerId } = event.payload;
    const existing = state.timers[timerId];
    if (!existing) throw new Error(`Unknown timer: ${timerId}`);
    if (existing.status !== "running" && existing.status !== "paused") {
      throw new Error(`Invalid timer transition: ${existing.status} -> cancelled`);
    }
    const remainingSeconds =
      existing.status === "paused"
        ? existing.remainingSeconds
        : Math.max(
            0,
            Math.ceil(
              ((existing.endsAt ?? event.occurredAt).getTime() - event.occurredAt.getTime()) / 1000,
            ),
          );
    timers = {
      ...state.timers,
      [timerId]: {
        ...existing,
        status: "cancelled",
        remainingSeconds,
        endsAt: undefined,
      },
    };
  }

  if (event.type === "world_state_updated") {
    // Full-document replace; stamp updatedAt from the event clock for coherence.
    worldState = { ...event.payload, updatedAt: event.occurredAt };
  }

  if (event.type === "session_started") {
    if (state.session.status !== "not_started" && state.session.status !== "paused") {
      throw new Error(`Invalid session transition: ${state.session.status} -> active`);
    }
    session = { ...state.session, status: "active", updatedAt: event.occurredAt };
  }

  if (event.type === "session_paused") {
    if (state.session.status !== "active") {
      throw new Error(`Invalid session transition: ${state.session.status} -> paused`);
    }
    session = { ...state.session, status: "paused", updatedAt: event.occurredAt };
  }

  if (event.type === "session_cancelled") {
    if (
      state.session.status !== "not_started" &&
      state.session.status !== "active" &&
      state.session.status !== "paused"
    ) {
      throw new Error(`Invalid session transition: ${state.session.status} -> cancelled`);
    }
    session = { ...state.session, status: "cancelled", updatedAt: event.occurredAt };
  }

  if (event.type === "goal_evaluated") {
    const payload = event.payload;
    const evaluation = criterionEvaluationSchema.parse({
      ...payload,
      evaluatedAt: event.occurredAt,
    });
    criterionEvaluations = {
      ...state.criterionEvaluations,
      [evaluation.criterionId]: evaluation,
    };
    criterionEvaluationHistory = [...state.criterionEvaluationHistory, evaluation];
    const latestEvaluations = latestCriterionEvaluations(state.plan.goal, criterionEvaluations);
    if (
      state.plan.goal.completionPolicy === "automatic" &&
      evaluateGoalCompletion(state.plan.goal, latestEvaluations) === "satisfied"
    ) {
      session = { ...state.session, status: "completed", updatedAt: event.occurredAt };
    }
  }

  if (event.type === "goal_completion_confirmed") {
    if (event.payload.goalId !== state.plan.goal.id)
      throw new Error("Goal confirmation ID mismatch");
    if (state.plan.goal.completionPolicy !== "human_confirmation") {
      throw new Error("Goal does not require human confirmation");
    }
    const latestEvaluations = latestCriterionEvaluations(
      state.plan.goal,
      criterionEvaluations,
    );
    if (evaluateGoalCompletion(state.plan.goal, latestEvaluations) !== "satisfied") {
      throw new Error("Cannot confirm goal completion before all criteria are satisfied");
    }
    session = { ...state.session, status: "completed", updatedAt: event.occurredAt };
  }

  return {
    ...state,
    session,
    worldState,
    stepStates,
    timers,
    criterionEvaluations,
    criterionEvaluationHistory,
    lastAppliedEventAt: event.occurredAt,
    appliedEventIds: [...state.appliedEventIds, event.id],
    appliedIdempotencyKeys: [...state.appliedIdempotencyKeys, event.idempotencyKey],
  };
}
