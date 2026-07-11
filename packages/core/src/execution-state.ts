import { z } from "zod";

import { criterionEvaluationSchema, evaluateGoalCompletion } from "./goal.js";
import { executionPlanSchema } from "./plan.js";
import { type RuntimeEvent } from "./event.js";
import { executionSessionSchema } from "./session.js";
import { stepStatesSchema, transitionStep } from "./step-state.js";
import { worldStateSchema } from "./world-state.js";
import { executionTimerSchema } from "./timer.js";

export const materializedExecutionStateSchema = z.object({
  session: executionSessionSchema,
  plan: executionPlanSchema(z.unknown()),
  worldState: worldStateSchema,
  stepStates: stepStatesSchema,
  timers: z.record(z.string(), executionTimerSchema),
  // Latest materialized evaluation by criterion ID. Evaluation history is
  // kept separately so duplicate/unknown evaluations remain visible to the
  // completion evaluator.
  criterionEvaluations: z.record(z.string(), criterionEvaluationSchema),
  criterionEvaluationHistory: z.array(criterionEvaluationSchema),
  lastAppliedEventAt: z.date().optional(),
  appliedEventIds: z.array(z.string().min(1)),
  appliedIdempotencyKeys: z.array(z.string().min(1)),
});

export type MaterializedExecutionState = z.infer<typeof materializedExecutionStateSchema>;

const stepPayloadSchema = z.object({ stepId: z.string().min(1) });
const timerStartedPayloadSchema = z.object({
  timerId: z.string().min(1),
  durationSeconds: z.number().nonnegative().optional(),
});
const timerPayloadSchema = z.object({ timerId: z.string().min(1) });
const goalEvaluatedPayloadSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(["satisfied", "unsatisfied", "unknown"]),
  evidence: z.array(z.unknown()),
});

export function applyRuntimeEvent(
  state: Readonly<MaterializedExecutionState>,
  event: RuntimeEvent,
): MaterializedExecutionState {
  if (
    state.appliedEventIds.includes(event.id) ||
    state.appliedIdempotencyKeys.includes(event.idempotencyKey)
  ) {
    return state;
  }

  if (event.sessionId !== state.session.id) {
    throw new Error(
      `Event session ${event.sessionId} does not match state session ${state.session.id}`,
    );
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
    const { stepId } = stepPayloadSchema.parse(event.payload);
    const current = state.stepStates[stepId];
    if (!current) throw new Error(`Unknown step: ${stepId}`);
    const nextStatus =
      event.type === "step_started"
        ? "active"
        : event.type === "step_completed"
          ? "completed"
          : "failed";
    stepStates = { ...state.stepStates, [stepId]: transitionStep(current, nextStatus) };
  }

  if (event.type === "timer_started") {
    const { timerId, durationSeconds } = timerStartedPayloadSchema.parse(event.payload);
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
    const { timerId } = timerPayloadSchema.parse(event.payload);
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
    const { timerId } = timerPayloadSchema.parse(event.payload);
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

  if (event.type === "world_state_updated") {
    worldState = worldStateSchema.parse(event.payload);
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

  if (event.type === "goal_evaluated") {
    const payload = goalEvaluatedPayloadSchema.parse(event.payload);
    const evaluation = criterionEvaluationSchema.parse({
      ...payload,
      evaluatedAt: event.occurredAt,
    });
    criterionEvaluations = {
      ...state.criterionEvaluations,
      [evaluation.criterionId]: evaluation,
    };
    criterionEvaluationHistory = [...state.criterionEvaluationHistory, evaluation];
    if (evaluateGoalCompletion(state.plan.goal, criterionEvaluationHistory) === "satisfied") {
      session = { ...state.session, status: "completed", updatedAt: event.occurredAt };
    }
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
