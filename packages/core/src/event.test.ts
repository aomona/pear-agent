import { describe, expect, it } from "vitest";

import { runtimeEventSchema } from "./event.js";

describe("runtimeEventSchema", () => {
  const event = {
    id: "event-1",
    sessionId: "session-1",
    idempotencyKey: "step-1-complete",
    actorId: "human-1",
    origin: "user",
    type: "step_completed",
    payload: { stepId: "pack" },
    occurredAt: new Date(),
  };

  it("accepts a core step-completed event", () => {
    expect(runtimeEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a domain event with a JSON-safe payload", () => {
    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "domain_event",
        domainType: "packing_item_added",
        payload: { itemId: "passport", packed: true },
      }).success,
    ).toBe(true);
  });

  it("rejects an event without an idempotency key", () => {
    expect(runtimeEventSchema.safeParse({ ...event, idempotencyKey: "" }).success).toBe(false);
  });

  it("rejects an unknown event type", () => {
    expect(runtimeEventSchema.safeParse({ ...event, type: "unknown_event" }).success).toBe(false);
  });

  it("rejects null and arbitrary core payloads", () => {
    expect(runtimeEventSchema.safeParse({ ...event, payload: null }).success).toBe(false);
    expect(runtimeEventSchema.safeParse({ ...event, payload: { arbitrary: true } }).success).toBe(
      false,
    );
    expect(
      runtimeEventSchema.safeParse({ ...event, type: "timer_paused", payload: {} }).success,
    ).toBe(false);
    expect(
      runtimeEventSchema.safeParse({ ...event, type: "goal_evaluated", payload: {} }).success,
    ).toBe(false);
  });

  it("accepts session and timer cancel events", () => {
    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "session_cancelled",
        payload: {},
      }).success,
    ).toBe(true);
    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "timer_cancelled",
        payload: { timerId: "tea" },
      }).success,
    ).toBe(true);
  });

  it("accepts step_paused and step_skipped events", () => {
    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "step_paused",
        payload: { stepId: "pack" },
      }).success,
    ).toBe(true);
    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "step_skipped",
        payload: { stepId: "pack" },
      }).success,
    ).toBe(true);
  });

  it("accepts world_state_facts_patched and plan_updated events", () => {
    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "world_state_facts_patched",
        payload: { facts: { packedItemIds: ["keys"] } },
      }).success,
    ).toBe(true);
    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "plan_updated",
        payload: {
          patchId: "patch-1",
          summary: "Delay affected packing",
          plan: {
            id: "plan-1",
            version: 2,
            goal: {
              id: "goal-1",
              description: "Pack",
              successCriteria: [
                {
                  id: "packed",
                  description: "Packed",
                  evaluator: { type: "human_confirmation" },
                },
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
        },
      }).success,
    ).toBe(true);

    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "replan_proposed",
        payload: { patchId: "patch-1", mode: "confirm" },
      }).success,
    ).toBe(true);
    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "replan_failed",
        payload: { patchId: "patch-1", reason: "stale base" },
      }).success,
    ).toBe(true);
    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "replan_failed",
        payload: { attemptId: "attempt-1", reason: "generator failed" },
      }).success,
    ).toBe(true);
    expect(
      runtimeEventSchema.safeParse({
        ...event,
        type: "replan_failed",
        payload: { reason: "missing identity" },
      }).success,
    ).toBe(false);
  });
});
