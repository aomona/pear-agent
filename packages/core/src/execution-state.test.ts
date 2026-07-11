import { describe, expect, it } from "vitest";

import {
  applyRuntimeEvent,
  materializedExecutionStateSchema,
  type MaterializedExecutionState,
} from "./execution-state.js";
import type { RuntimeEvent } from "./event.js";

const now = new Date("2026-07-11T00:00:00.000Z");

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
    steps: [],
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

  it("starts, pauses, resumes, and completes a timer", () => {
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
  });

  it("rejects timer operations for a timer that does not exist", () => {
    expect(() =>
      applyRuntimeEvent(initialState, timerEvent("timer_paused", { timerId: "missing" })),
    ).toThrow("Unknown timer");
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

  it("overwrites the materialized evaluation while retaining duplicate history for completion", () => {
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

  it("completes a multi-criterion goal once its complete evaluation history is satisfied", () => {
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
});

function timerEvent(
  type: "timer_started" | "timer_paused" | "timer_completed",
  payload: Record<string, string | number>,
  seconds = 0,
): Extract<RuntimeEvent, { type: "timer_started" | "timer_paused" | "timer_completed" }> {
  return {
    id: `timer-${type}-${seconds}`,
    sessionId: "session-1",
    idempotencyKey: `timer-${type}-${seconds}`,
    actorId: "human-1",
    origin: "user",
    type,
    payload,
    occurredAt: new Date(now.getTime() + seconds * 1000),
  } as Extract<RuntimeEvent, { type: "timer_started" | "timer_paused" | "timer_completed" }>;
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
