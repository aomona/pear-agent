import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECENT_EVENT_LIMIT,
  InMemoryExecutionStateRepository,
  type AppendEventResult,
} from "./repository.js";
import type { MaterializedExecutionState } from "./execution-state.js";
import { criterionEvaluationSchema } from "./goal.js";

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
  it("creates, reads, appends atomically, and returns a current snapshot", async () => {
    const repository = new InMemoryExecutionStateRepository();
    await repository.create(state);

    expect(await repository.get("session-1")).toEqual(state);
    const result = await repository.appendEvent(event);
    expect(result.kind).toBe("applied");
    expect((await repository.get("session-1"))?.stepStates.pack).toEqual({ status: "completed" });
    expect((await repository.getSnapshot("session-1"))?.stepStates.pack).toEqual({
      status: "completed",
    });
    expect((await repository.getSnapshot("session-1"))?.recentEvents).toEqual([event]);
  });

  it("defensively clones state and event values at every repository boundary", async () => {
    const repository = new InMemoryExecutionStateRepository();
    await repository.create(state);

    const read = (await repository.get("session-1"))!;
    read.stepStates.pack = { status: "completed" };
    read.worldState.facts.changed = true;
    expect((await repository.get("session-1"))?.stepStates.pack).toEqual({ status: "active" });
    expect((await repository.get("session-1"))?.worldState.facts).toEqual({});

    const result = await repository.appendEvent(event);
    result.state.stepStates.pack = { status: "active" };
    if (result.event.type === "step_completed") {
      (result.event.payload as { stepId: string }).stepId = "other";
    }
    expect((await repository.get("session-1"))?.stepStates.pack).toEqual({ status: "completed" });
    expect((await repository.getSnapshot("session-1"))?.recentEvents).toEqual([event]);

    const snapshot = (await repository.getSnapshot("session-1"))!;
    snapshot.worldState.facts.changedAgain = true;
    snapshot.recentEvents[0]!.payload = { stepId: "other" };
    expect((await repository.getSnapshot("session-1"))?.worldState.facts).toEqual({});
    expect((await repository.getSnapshot("session-1"))?.recentEvents).toEqual([event]);
  });

  it("does not apply the same idempotency key twice within one session", async () => {
    const repository = new InMemoryExecutionStateRepository([state]);
    const first = await repository.appendEvent(event);
    const second = await repository.appendEvent({ ...event, id: "event-2" });

    expect(first.kind).toBe("applied");
    expect(second.kind).toBe("duplicate");
    expect((await repository.get("session-1"))?.appliedEventIds).toEqual(["event-1"]);
    expect((await repository.getSnapshot("session-1"))?.recentEvents).toEqual([event]);

    second.state.stepStates.pack = { status: "active" };
    if (second.event.type === "step_completed") {
      (second.event.payload as { stepId: string }).stepId = "other";
    }
    expect((await repository.get("session-1"))?.stepStates.pack).toEqual({ status: "completed" });
    expect((await repository.getSnapshot("session-1"))?.recentEvents).toEqual([event]);
  });

  it("allows the same idempotency key in a different session", async () => {
    const other = { ...state, session: { ...state.session, id: "session-2" } };
    const repository = new InMemoryExecutionStateRepository([state, other]);
    expect((await repository.appendEvent(event)).kind).toBe("applied");
    expect(
      (await repository.appendEvent({ ...event, id: "event-2", sessionId: "session-2" })).kind,
    ).toBe("applied");
  });

  it("keeps event log and state unchanged when event application fails", async () => {
    const repository = new InMemoryExecutionStateRepository([state]);
    await expect(
      repository.appendEvent({
        ...event,
        id: "event-invalid",
        idempotencyKey: "invalid-transition",
        type: "step_started",
      }),
    ).rejects.toThrow("Invalid step transition");
    expect(await repository.get("session-1")).toEqual(state);
    expect((await repository.getSnapshot("session-1"))?.recentEvents).toEqual([]);
  });

  it("returns undefined for an unknown session", async () => {
    const repository = new InMemoryExecutionStateRepository();
    expect(await repository.get("missing")).toBeUndefined();
    expect(await repository.getSnapshot("missing")).toBeUndefined();
  });

  it("exposes a discriminated append result", async () => {
    const repository = new InMemoryExecutionStateRepository([state]);
    const result: AppendEventResult = await repository.appendEvent(event);
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") expect(result.event).toEqual(event);
  });

  it("windows recentEvents in snapshots by default and option", async () => {
    const repository = new InMemoryExecutionStateRepository([state]);
    expect(DEFAULT_RECENT_EVENT_LIMIT).toBe(100);

    for (let i = 0; i < 3; i += 1) {
      await repository.appendEvent({
        id: `evt-${i}`,
        sessionId: "session-1",
        idempotencyKey: `world-${i}`,
        actorId: "human-1",
        origin: "user",
        type: "world_state_updated",
        payload: {
          facts: { i },
          resources: [],
          observations: [],
          activeConstraints: [],
          updatedAt: now,
        },
        occurredAt: new Date(now.getTime() + i * 1000),
      });
    }

    const limited = await repository.getSnapshot("session-1", { recentEventLimit: 2 });
    expect(limited?.recentEvents).toHaveLength(2);
    expect(limited?.recentEvents.map((e) => e.id)).toEqual(["evt-1", "evt-2"]);

    const empty = await repository.getSnapshot("session-1", { recentEventLimit: 0 });
    expect(empty?.recentEvents).toEqual([]);
  });

  it("rejects non-JSON-safe goal evaluation evidence at the repository boundary", async () => {
    const repository = new InMemoryExecutionStateRepository([state]);
    const badEvidence = { criterionId: "ready", status: "satisfied", evidence: [() => 1] };
    expect(criterionEvaluationSchema.safeParse({ ...badEvidence, evaluatedAt: now }).success).toBe(
      false,
    );
    await expect(
      repository.appendEvent({
        id: "bad-eval",
        sessionId: "session-1",
        idempotencyKey: "bad-eval",
        actorId: "human-1",
        origin: "user",
        type: "goal_evaluated",
        payload: badEvidence as never,
        occurredAt: now,
      }),
    ).rejects.toThrow();
  });
});
