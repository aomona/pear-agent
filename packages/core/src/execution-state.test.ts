import { describe, expect, it } from "vitest";

import {
  applyRuntimeEvent,
  materializedExecutionStateSchema,
  type MaterializedExecutionState,
} from "./execution-state.js";
import type { RuntimeEvent } from "./event.js";
import type { ExecutionStep } from "./plan.js";

const now = new Date("2026-07-11T00:00:00.000Z");

const packStep: ExecutionStep = {
  id: "pack",
  executor: { type: "human" },
  after: [],
  requirements: [],
  estimatedDurationSeconds: 60,
  timers: [],
  domainData: {},
};

const initialState: MaterializedExecutionState = {
  session: {
    id: "session-1",
    planId: "plan-1",
    planVersion: 1,
    goalId: "goal-1",
    status: "active",
    actorIds: ["human-1"],
    createdAt: now,
    updatedAt: now,
  },
  plan: {
    id: "plan-1",
    version: 1,
    goal: {
      id: "goal-1",
      description: "Pack for the outing",
      successCriteria: [
        { id: "packed", description: "Bag is packed", evaluator: { type: "human_confirmation" } },
      ],
      completionPolicy: "automatic",
    },
    steps: [packStep],
  },
  worldState: { facts: {}, resources: [], observations: [], activeConstraints: [], updatedAt: now },
  stepStates: { pack: { status: "active" } },
  timers: {},
  criterionEvaluations: {},
  criterionEvaluationHistory: [],
  lastAppliedEventAt: undefined,
  appliedEventIds: [],
  appliedIdempotencyKeys: [],
};

describe("applyRuntimeEvent", () => {
  it("rejects an invalid plan when materializing execution state", () => {
    const invalidPlan = {
      ...initialState,
      plan: { ...initialState.plan, version: 0 },
    };

    expect(materializedExecutionStateSchema.safeParse(invalidPlan).success).toBe(false);
  });

  it("completes a step without mutating the input state", () => {
    const next = applyRuntimeEvent(initialState, {
      id: "event-1",
      sessionId: "session-1",
      idempotencyKey: "pack-complete",
      actorId: "human-1",
      origin: "user",
      type: "step_completed",
      payload: { stepId: "pack" },
      occurredAt: now,
    });

    expect(next.stepStates.pack).toEqual({ status: "completed" });
    expect(next.appliedEventIds).toContain("event-1");
    expect(initialState.stepStates.pack).toEqual({ status: "active" });
  });

  it("returns the unchanged state for duplicate event IDs or idempotency keys", () => {
    const event = {
      id: "event-1",
      sessionId: "session-1",
      idempotencyKey: "pack-complete",
      actorId: "human-1",
      origin: "user",
      type: "step_completed" as const,
      payload: { stepId: "pack" },
      occurredAt: now,
    };
    const completed = applyRuntimeEvent(initialState, event);

    expect(applyRuntimeEvent(completed, event)).toBe(completed);
    expect(applyRuntimeEvent(completed, { ...event, id: "event-2" })).toBe(completed);
  });

  it("rejects an invalid transition from a completed step", () => {
    expect(() =>
      applyRuntimeEvent(
        { ...initialState, stepStates: { pack: { status: "completed" } } },
        {
          id: "event-2",
          sessionId: "session-1",
          idempotencyKey: "pack-start",
          actorId: "human-1",
          origin: "user",
          type: "step_started",
          payload: { stepId: "pack" },
          occurredAt: now,
        },
      ),
    ).toThrow("Invalid step transition");
  });

  it("marks dependent steps ready after dependencies complete", () => {
    const leave: ExecutionStep = {
      id: "leave",
      executor: { type: "human" },
      after: ["pack", "charge"],
      requirements: [],
      estimatedDurationSeconds: 30,
      timers: [],
      domainData: {},
    };
    const charge: ExecutionStep = {
      id: "charge",
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 60,
      timers: [],
      domainData: {},
    };
    const dagState: MaterializedExecutionState = {
      ...initialState,
      plan: {
        ...initialState.plan,
        steps: [packStep, charge, leave],
      },
      stepStates: {
        pack: { status: "ready" },
        charge: { status: "ready" },
        leave: { status: "blocked" },
      },
    };

    const packStarted = applyRuntimeEvent(dagState, stepEvent("step_started", "pack", 0));
    const packDone = applyRuntimeEvent(packStarted, stepEvent("step_completed", "pack", 1));
    expect(packDone.stepStates.leave).toEqual({ status: "blocked" });

    const chargeStarted = applyRuntimeEvent(packDone, stepEvent("step_started", "charge", 2));
    const chargeDone = applyRuntimeEvent(chargeStarted, stepEvent("step_completed", "charge", 3));
    expect(chargeDone.stepStates).toMatchObject({
      pack: { status: "completed" },
      charge: { status: "completed" },
      leave: { status: "ready" },
    });
  });

  it("starts, pauses, resumes, completes, and cancels a timer", () => {
    const started = applyRuntimeEvent(
      initialState,
      timerEvent("timer_started", { timerId: "tea", durationSeconds: 60 }),
    );
    const paused = applyRuntimeEvent(started, timerEvent("timer_paused", { timerId: "tea" }, 10));
    const resumed = applyRuntimeEvent(paused, timerEvent("timer_started", { timerId: "tea" }, 20));
    const completed = applyRuntimeEvent(
      resumed,
      timerEvent("timer_completed", { timerId: "tea" }, 25),
    );

    expect(started.timers.tea).toMatchObject({ status: "running", remainingSeconds: 60 });
    expect(paused.timers.tea).toMatchObject({ status: "paused", remainingSeconds: 50 });
    expect(resumed.timers.tea).toMatchObject({ status: "running", remainingSeconds: 50 });
    expect(completed.timers.tea).toMatchObject({ status: "completed", remainingSeconds: 0 });

    const cancelled = applyRuntimeEvent(
      paused,
      timerEvent("timer_cancelled", { timerId: "tea" }, 15),
    );
    expect(cancelled.timers.tea).toMatchObject({ status: "cancelled", remainingSeconds: 50 });
  });

  it("rejects timer operations for a timer that does not exist", () => {
    expect(() =>
      applyRuntimeEvent(initialState, timerEvent("timer_paused", { timerId: "missing" })),
    ).toThrow("Unknown timer");
  });

  it("stamps world state updatedAt from the event clock on full replace", () => {
    const occurredAt = new Date("2026-07-11T01:00:00.000Z");
    const next = applyRuntimeEvent(initialState, {
      id: "world-1",
      sessionId: "session-1",
      idempotencyKey: "world-1",
      actorId: "human-1",
      origin: "user",
      type: "world_state_updated",
      payload: {
        facts: { packed: true },
        resources: [],
        observations: [],
        activeConstraints: [],
        updatedAt: now,
      },
      occurredAt,
    });

    expect(next.worldState).toMatchObject({
      facts: { packed: true },
      updatedAt: occurredAt,
    });
  });

  it("cancels an active session and rejects further non-duplicate events", () => {
    const cancelled = applyRuntimeEvent(initialState, {
      id: "cancel-1",
      sessionId: "session-1",
      idempotencyKey: "cancel-1",
      actorId: "human-1",
      origin: "user",
      type: "session_cancelled",
      payload: {},
      occurredAt: now,
    });
    expect(cancelled.session.status).toBe("cancelled");

    expect(() =>
      applyRuntimeEvent(cancelled, {
        id: "after-cancel",
        sessionId: "session-1",
        idempotencyKey: "after-cancel",
        actorId: "human-1",
        origin: "user",
        type: "step_completed",
        payload: { stepId: "pack" },
        occurredAt: now,
      }),
    ).toThrow("Cannot apply event to cancelled session");
  });

  it("completes the session only when every criterion is satisfied exactly once", () => {
    const evaluated = applyRuntimeEvent(initialState, goalEvent("packed", "satisfied"));
    expect(evaluated.session.status).toBe("completed");
  });

  it("keeps evaluation history so missing, duplicate, and unknown evaluations are incomplete", () => {
    const twoCriterionState: MaterializedExecutionState = {
      ...initialState,
      plan: {
        ...initialState.plan,
        goal: {
          ...initialState.plan.goal,
          successCriteria: [
            ...initialState.plan.goal.successCriteria,
            {
              id: "ready",
              description: "Ready to leave",
              evaluator: { type: "human_confirmation" },
            },
          ],
        },
      },
    };
    const missing = applyRuntimeEvent(twoCriterionState, goalEvent("packed", "satisfied"));
    const duplicate = applyRuntimeEvent(missing, goalEvent("packed", "satisfied", 1));
    const unknown = applyRuntimeEvent(twoCriterionState, goalEvent("unknown", "satisfied", 2));

    expect(missing.session.status).toBe("active");
    expect(duplicate.session.status).toBe("active");
    expect(unknown.session.status).toBe("active");
    expect(duplicate.criterionEvaluations).toMatchObject({ packed: { status: "satisfied" } });
    expect(unknown.criterionEvaluations).toMatchObject({ unknown: { status: "satisfied" } });
    expect(duplicate.criterionEvaluationHistory).toHaveLength(2);
    expect(unknown.criterionEvaluationHistory).toHaveLength(1);
  });

  it("overwrites the materialized evaluation while retaining duplicate history", () => {
    const twoCriterionState: MaterializedExecutionState = {
      ...initialState,
      plan: {
        ...initialState.plan,
        goal: {
          ...initialState.plan.goal,
          successCriteria: [
            ...initialState.plan.goal.successCriteria,
            {
              id: "ready",
              description: "Ready to leave",
              evaluator: { type: "human_confirmation" },
            },
          ],
        },
      },
    };

    const first = applyRuntimeEvent(twoCriterionState, goalEvent("packed", "satisfied"));
    const duplicate = applyRuntimeEvent(first, goalEvent("packed", "unsatisfied", 1));

    expect(duplicate.criterionEvaluations).toMatchObject({ packed: { status: "unsatisfied" } });
    expect(duplicate.criterionEvaluationHistory).toHaveLength(2);
    expect(duplicate.session.status).toBe("active");
  });

  it("completes a multi-criterion goal once every latest evaluation is satisfied", () => {
    const state: MaterializedExecutionState = {
      ...initialState,
      plan: {
        ...initialState.plan,
        goal: {
          ...initialState.plan.goal,
          successCriteria: [
            ...initialState.plan.goal.successCriteria,
            {
              id: "ready",
              description: "Ready to leave",
              evaluator: { type: "human_confirmation" },
            },
          ],
        },
      },
    };

    const partlyEvaluated = applyRuntimeEvent(state, goalEvent("packed", "satisfied"));
    const completed = applyRuntimeEvent(partlyEvaluated, goalEvent("ready", "satisfied", 1));

    expect(partlyEvaluated.session.status).toBe("active");
    expect(completed.session.status).toBe("completed");
  });

  it("uses only the latest evaluation of each criterion for automatic completion", () => {
    const unknown = applyRuntimeEvent(initialState, goalEvent("packed", "unknown"));
    const unsatisfied = applyRuntimeEvent(unknown, goalEvent("packed", "unsatisfied", 1));
    const satisfied = applyRuntimeEvent(unsatisfied, goalEvent("packed", "satisfied", 2));

    expect(satisfied.criterionEvaluations).toMatchObject({ packed: { status: "satisfied" } });
    expect(satisfied.criterionEvaluationHistory).toHaveLength(3);
    expect(satisfied.session.status).toBe("completed");
  });

  it("ignores unknown criterion keys when deciding completion", () => {
    const withUnknown: MaterializedExecutionState = {
      ...initialState,
      criterionEvaluations: {
        unknown: {
          criterionId: "unknown",
          status: "satisfied",
          evidence: [],
          evaluatedAt: now,
        },
      },
      criterionEvaluationHistory: [
        {
          criterionId: "unknown",
          status: "satisfied",
          evidence: [],
          evaluatedAt: now,
        },
      ],
    };

    const completed = applyRuntimeEvent(withUnknown, goalEvent("packed", "satisfied"));
    expect(completed.session.status).toBe("completed");
  });

  it("rejects further events after automatic completion except duplicates", () => {
    const completed = applyRuntimeEvent(initialState, goalEvent("packed", "satisfied"));
    expect(completed.session.status).toBe("completed");

    expect(() =>
      applyRuntimeEvent(completed, {
        id: "after-complete",
        sessionId: "session-1",
        idempotencyKey: "after-complete",
        actorId: "human-1",
        origin: "user",
        type: "step_completed",
        payload: { stepId: "pack" },
        occurredAt: now,
      }),
    ).toThrow("Cannot apply event to completed session");

    const duplicate = applyRuntimeEvent(completed, goalEvent("packed", "satisfied"));
    expect(duplicate).toBe(completed);
  });

  it("requires an explicit valid confirmation for human-confirmation goals", () => {
    const state: MaterializedExecutionState = {
      ...initialState,
      plan: {
        ...initialState.plan,
        goal: { ...initialState.plan.goal, completionPolicy: "human_confirmation" },
      },
    };
    expect(() => applyRuntimeEvent(state, confirmationEvent())).toThrow(
      "before all criteria are satisfied",
    );

    const evaluated = applyRuntimeEvent(state, goalEvent("packed", "satisfied"));
    expect(evaluated.session.status).toBe("active");
    expect(applyRuntimeEvent(evaluated, confirmationEvent()).session.status).toBe("completed");
  });

  it("allows human confirmation after re-evaluation reaches a satisfied latest set", () => {
    const state: MaterializedExecutionState = {
      ...initialState,
      plan: {
        ...initialState.plan,
        goal: { ...initialState.plan.goal, completionPolicy: "human_confirmation" },
      },
    };
    const unsatisfied = applyRuntimeEvent(state, goalEvent("packed", "unsatisfied"));
    const satisfied = applyRuntimeEvent(unsatisfied, goalEvent("packed", "satisfied", 1));
    expect(satisfied.session.status).toBe("active");
    expect(applyRuntimeEvent(satisfied, confirmationEvent()).session.status).toBe("completed");
  });
});

function confirmationEvent(): Extract<RuntimeEvent, { type: "goal_completion_confirmed" }> {
  return {
    id: "goal-confirmed",
    sessionId: "session-1",
    idempotencyKey: "goal-confirmed",
    actorId: "human-1",
    origin: "user",
    type: "goal_completion_confirmed",
    payload: { goalId: "goal-1" },
    occurredAt: now,
  };
}

function stepEvent(
  type: "step_started" | "step_completed" | "step_failed",
  stepId: string,
  suffix: number,
): Extract<RuntimeEvent, { type: "step_started" | "step_completed" | "step_failed" }> {
  return {
    id: `${type}-${stepId}-${suffix}`,
    sessionId: "session-1",
    idempotencyKey: `${type}-${stepId}-${suffix}`,
    actorId: "human-1",
    origin: "user",
    type,
    payload: { stepId },
    occurredAt: new Date(now.getTime() + suffix * 1000),
  };
}

function timerEvent(
  type: "timer_started" | "timer_paused" | "timer_completed" | "timer_cancelled",
  payload: Record<string, string | number>,
  seconds = 0,
): Extract<
  RuntimeEvent,
  { type: "timer_started" | "timer_paused" | "timer_completed" | "timer_cancelled" }
> {
  return {
    id: `timer-${type}-${seconds}`,
    sessionId: "session-1",
    idempotencyKey: `timer-${type}-${seconds}`,
    actorId: "human-1",
    origin: "user",
    type,
    payload,
    occurredAt: new Date(now.getTime() + seconds * 1000),
  } as Extract<
    RuntimeEvent,
    { type: "timer_started" | "timer_paused" | "timer_completed" | "timer_cancelled" }
  >;
}

function goalEvent(
  criterionId: string,
  status: "satisfied" | "unsatisfied" | "unknown",
  suffix = 0,
) {
  return {
    id: `goal-${criterionId}-${suffix}`,
    sessionId: "session-1",
    idempotencyKey: `goal-${criterionId}-${suffix}`,
    actorId: "human-1",
    origin: "user",
    type: "goal_evaluated" as const,
    payload: { criterionId, status, evidence: [] },
    occurredAt: new Date(now.getTime() + suffix * 1000),
  };
}
