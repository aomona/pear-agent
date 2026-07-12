import { describe, expect, it } from "vitest";

import { createRuntimeSnapshot, runtimeSnapshotSchema, type RuntimeSnapshot } from "./snapshot.js";
import type { RuntimeEvent } from "./event.js";
import type { MaterializedExecutionState } from "./execution-state.js";

const now = new Date("2026-07-11T00:00:00.000Z");
const plan = {
  id: "plan-1",
  version: 1,
  goal: {
    id: "goal-1",
    description: "Leave home",
    successCriteria: [
      { id: "ready", description: "Ready", evaluator: { type: "human_confirmation" as const } },
    ],
    completionPolicy: "automatic" as const,
  },
  steps: [
    {
      id: "pack",
      executor: { type: "human" as const },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 60,
      timers: [],
      domainData: {},
    },
    {
      id: "charge",
      executor: { type: "human" as const },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 60,
      timers: [],
      domainData: {},
    },
  ],
};

const state: MaterializedExecutionState = {
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
  plan,
  worldState: { facts: {}, resources: [], observations: [], activeConstraints: [], updatedAt: now },
  stepStates: {
    pack: { status: "ready" },
    charge: { status: "active" },
    stale: { status: "blocked" },
    completed: { status: "completed" },
  },
  timers: {
    tea: {
      id: "tea",
      status: "running",
      durationSeconds: 60,
      remainingSeconds: 30,
      startedAt: now,
      endsAt: new Date(now.getTime() + 30_000),
    },
    paused: {
      id: "paused",
      status: "paused",
      durationSeconds: 60,
      remainingSeconds: 30,
      startedAt: now,
    },
  },
  criterionEvaluations: {},
  criterionEvaluationHistory: [],
  appliedEventIds: [],
  appliedIdempotencyKeys: [],
};

const event: RuntimeEvent = {
  id: "event-1",
  sessionId: "session-1",
  idempotencyKey: "pack-complete",
  actorId: "human-1",
  origin: "user",
  type: "step_completed",
  payload: { stepId: "pack" },
  occurredAt: now,
};

describe("createRuntimeSnapshot", () => {
  it("includes state, active timers, recent events, and derived step IDs", () => {
    const snapshot = createRuntimeSnapshot({ plan, state, recentEvents: [event] });

    expect(snapshot.session.id).toBe("session-1");
    expect(snapshot.plan.id).toBe("plan-1");
    expect(snapshot.worldState).toEqual(state.worldState);
    expect(snapshot.stepStates).toEqual({
      pack: { status: "ready" },
      charge: { status: "active" },
    });
    expect(snapshot.activeTimers).toEqual([state.timers.tea]);
    expect(snapshot.recentEvents).toEqual([event]);
    expect(snapshot.readyStepIds).toEqual(["pack"]);
    expect(snapshot.activeStepIds).toEqual(["charge"]);
    expect(snapshot.blockedStepIds).toEqual([]);
    expect(snapshot.generatedAt).toBeInstanceOf(Date);
    expect(snapshot.latestPlanChange).toBeNull();
    expect(snapshot.stepStates).not.toHaveProperty("stale");
  });

  it("does not expose step-state keys that are not in the plan", () => {
    const snapshot = createRuntimeSnapshot({ plan, state, recentEvents: [] });
    expect(Object.keys(snapshot.stepStates)).toEqual(["pack", "charge"]);
    expect(snapshot.blockedStepIds).not.toContain("stale");
  });

  it("rejects plans or states with inconsistent identity/version metadata", () => {
    expect(() =>
      createRuntimeSnapshot({
        plan: { ...plan, id: "other-plan" },
        state,
        recentEvents: [],
      }),
    ).toThrow("Plan identity/version");
    expect(() =>
      createRuntimeSnapshot({
        plan,
        state: { ...state, plan: { ...state.plan, version: 2 } },
        recentEvents: [],
      }),
    ).toThrow("Plan identity/version");
  });

  it.each([
    [
      "steps",
      { ...plan, steps: [{ ...plan.steps[0]!, estimatedDurationSeconds: 120 }, plan.steps[1]!] },
    ],
    ["goal", { ...plan, goal: { ...plan.goal, description: "Stay home" } }],
    [
      "domain data",
      { ...plan, steps: [{ ...plan.steps[0]!, domainData: { changed: true } }, plan.steps[1]!] },
    ],
  ])("rejects the same plan identity/version with differing %s", (_name, suppliedPlan) => {
    expect(() => createRuntimeSnapshot({ plan: suppliedPlan, state, recentEvents: [] })).toThrow(
      "Supplied plan does not match execution state plan",
    );
  });

  it("accepts equivalent domain data with different object key insertion order", () => {
    const suppliedPlan = {
      ...plan,
      steps: [{ ...plan.steps[0]!, domainData: { first: 1, second: 2 } }, plan.steps[1]!],
    };
    const statePlan = {
      ...plan,
      steps: [{ ...plan.steps[0]!, domainData: { second: 2, first: 1 } }, plan.steps[1]!],
    };

    expect(() =>
      createRuntimeSnapshot({
        plan: suppliedPlan,
        state: { ...state, plan: statePlan },
        recentEvents: [],
      }),
    ).not.toThrow();
  });

  it("rejects a session whose goal does not match the plan", () => {
    expect(() =>
      createRuntimeSnapshot({
        plan,
        state: { ...state, session: { ...state.session, goalId: "other-goal" } },
        recentEvents: [],
      }),
    ).toThrow("Session goal does not match execution plan goal");
  });

  it("rejects recent events from another session", () => {
    expect(() =>
      createRuntimeSnapshot({
        plan,
        state,
        recentEvents: [{ ...event, sessionId: "session-2" }],
      }),
    ).toThrow("Recent event does not belong to execution session");
  });

  it("rejects malformed materialized state and non-running active timers", () => {
    expect(() =>
      createRuntimeSnapshot({
        plan,
        state: { ...state, plan: { ...state.plan, steps: "invalid" } } as never,
        recentEvents: [],
      }),
    ).toThrow();

    const snapshot = createRuntimeSnapshot({ plan, state, recentEvents: [] });
    expect(
      runtimeSnapshotSchema.safeParse({
        ...snapshot,
        activeTimers: [state.timers.paused],
      }).success,
    ).toBe(false);
  });

  it("validates the public snapshot shape", () => {
    const snapshot: RuntimeSnapshot = createRuntimeSnapshot({ plan, state, recentEvents: [] });
    expect(runtimeSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      runtimeSnapshotSchema.safeParse({ ...snapshot, generatedAt: "not-a-date" }).success,
    ).toBe(false);
  });
});
