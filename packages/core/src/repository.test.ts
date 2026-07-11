import { describe, expect, it } from "vitest";

import { InMemoryExecutionStateRepository, type AppendEventResult } from "./repository.js";
import type { MaterializedExecutionState } from "./execution-state.js";

const now = new Date("2026-07-11T00:00:00.000Z");
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
  plan: {
    id: "plan-1",
    version: 1,
    goal: {
      id: "goal-1",
      description: "Leave home",
      successCriteria: [
        { id: "ready", description: "Ready", evaluator: { type: "human_confirmation" } },
      ],
      completionPolicy: "automatic",
    },
    steps: [
      {
        id: "pack",
        executor: { type: "human" },
        after: [],
        requirements: [],
        estimatedDurationSeconds: 60,
        timers: [],
        domainData: {},
      },
    ],
  },
  worldState: { facts: {}, resources: [], observations: [], activeConstraints: [], updatedAt: now },
  stepStates: { pack: { status: "active" } },
  timers: {},
  criterionEvaluations: {},
  criterionEvaluationHistory: [],
  appliedEventIds: [],
  appliedIdempotencyKeys: [],
};

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

describe("InMemoryExecutionStateRepository", () => {
  it("creates, reads, appends atomically, and returns a current snapshot", () => {
    const repository = new InMemoryExecutionStateRepository();
    repository.create(state);

    expect(repository.get("session-1")).toEqual(state);
    const result = repository.appendEvent(event);
    expect(result.kind).toBe("applied");
    expect(repository.get("session-1")?.stepStates.pack).toEqual({ status: "completed" });
    expect(repository.getSnapshot("session-1")?.stepStates.pack).toEqual({ status: "completed" });
    expect(repository.getSnapshot("session-1")?.recentEvents).toEqual([event]);
  });

  it("does not apply the same idempotency key twice within one session", () => {
    const repository = new InMemoryExecutionStateRepository([state]);
    const first = repository.appendEvent(event);
    const second = repository.appendEvent({ ...event, id: "event-2" });

    expect(first.kind).toBe("applied");
    expect(second.kind).toBe("duplicate");
    expect(repository.get("session-1")?.appliedEventIds).toEqual(["event-1"]);
    expect(repository.getSnapshot("session-1")?.recentEvents).toEqual([event]);
  });

  it("allows the same idempotency key in a different session", () => {
    const other = { ...state, session: { ...state.session, id: "session-2" } };
    const repository = new InMemoryExecutionStateRepository([state, other]);
    expect(repository.appendEvent(event).kind).toBe("applied");
    expect(repository.appendEvent({ ...event, id: "event-2", sessionId: "session-2" }).kind).toBe(
      "applied",
    );
  });

  it("keeps event log and state unchanged when event application fails", () => {
    const repository = new InMemoryExecutionStateRepository([state]);
    expect(() =>
      repository.appendEvent({
        ...event,
        id: "event-invalid",
        idempotencyKey: "invalid-transition",
        type: "step_started",
      }),
    ).toThrow("Invalid step transition");
    expect(repository.get("session-1")).toEqual(state);
    expect(repository.getSnapshot("session-1")?.recentEvents).toEqual([]);
  });

  it("returns undefined for an unknown session", () => {
    const repository = new InMemoryExecutionStateRepository();
    expect(repository.get("missing")).toBeUndefined();
    expect(repository.getSnapshot("missing")).toBeUndefined();
  });

  it("exposes a discriminated append result", () => {
    const repository = new InMemoryExecutionStateRepository([state]);
    const result: AppendEventResult = repository.appendEvent(event);
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") expect(result.event).toEqual(event);
  });
});
