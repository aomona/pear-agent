import { describe, expect, it } from "vitest";

import {
  InMemoryExecutionStateRepository,
  type MaterializedExecutionState,
  type RuntimeEvent,
} from "./index.js";

const startedAt = new Date("2026-07-11T00:00:00.000Z");

function event(
  id: string,
  type: RuntimeEvent["type"],
  payload: RuntimeEvent["payload"],
  occurredAt = startedAt,
): RuntimeEvent {
  return {
    id,
    sessionId: "outing-session",
    idempotencyKey: id,
    actorId: "traveler",
    origin: "user",
    type,
    payload,
    occurredAt,
  } as RuntimeEvent;
}

describe("execution state contract", () => {
  it("runs independent packing and charging work through timer and goal completion", () => {
    const initialState: MaterializedExecutionState = {
      session: {
        id: "outing-session",
        planId: "outing-plan",
        planVersion: 1,
        goalId: "ready-to-leave",
        status: "active",
        actorIds: ["traveler"],
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      plan: {
        id: "outing-plan",
        version: 1,
        goal: {
          id: "ready-to-leave",
          description: "Be ready to leave",
          successCriteria: [
            {
              id: "packed",
              description: "Belongings are packed",
              evaluator: { type: "state_rule" },
            },
            { id: "charged", description: "Phone is charged", evaluator: { type: "state_rule" } },
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
          {
            id: "charge",
            executor: { type: "human" },
            after: [],
            requirements: [],
            estimatedDurationSeconds: 300,
            timers: [],
            domainData: {},
          },
        ],
      },
      worldState: {
        facts: {},
        resources: [],
        observations: [],
        activeConstraints: [],
        updatedAt: startedAt,
      },
      stepStates: { pack: { status: "ready" }, charge: { status: "ready" } },
      timers: {},
      criterionEvaluations: {},
      criterionEvaluationHistory: [],
      appliedEventIds: [],
      appliedIdempotencyKeys: [],
    };
    const repository = new InMemoryExecutionStateRepository([initialState]);

    expect(repository.getSnapshot("outing-session")?.readyStepIds).toEqual(["pack", "charge"]);

    repository.appendEvent(event("charge-start", "step_started", { stepId: "charge" }));
    repository.appendEvent(
      event("charge-timer-start", "timer_started", {
        timerId: "charge-phone",
        durationSeconds: 300,
      }),
    );
    repository.appendEvent(event("pack-start", "step_started", { stepId: "pack" }));
    repository.appendEvent(event("pack-complete", "step_completed", { stepId: "pack" }));

    const inProgress = repository.getSnapshot("outing-session")!;
    expect(inProgress.stepStates.pack).toEqual({ status: "completed" });
    expect(inProgress.stepStates.charge).toEqual({ status: "active" });
    expect(inProgress.activeStepIds).toEqual(["charge"]);

    const timerEndedAt = new Date("2026-07-11T00:05:00.000Z");
    repository.appendEvent(
      event("charge-timer-complete", "timer_completed", { timerId: "charge-phone" }, timerEndedAt),
    );
    repository.appendEvent(
      event("charge-complete", "step_completed", { stepId: "charge" }, timerEndedAt),
    );
    repository.appendEvent(
      event(
        "packed-evaluated",
        "goal_evaluated",
        { criterionId: "packed", status: "satisfied", evidence: ["pack-complete"] },
        timerEndedAt,
      ),
    );
    repository.appendEvent(
      event(
        "charged-evaluated",
        "goal_evaluated",
        { criterionId: "charged", status: "satisfied", evidence: ["charge-timer-complete"] },
        timerEndedAt,
      ),
    );

    const completed = repository.getSnapshot("outing-session")!;
    expect(completed.activeTimers).toEqual([]);
    expect(completed.session.status).toBe("completed");
  });
});
