import { describe, expect, it } from "vitest";

import { schedulePlan } from "./plan-schedule.js";
import type { ExecutionPlan } from "./plan.js";

const goal = {
  id: "g",
  description: "goal",
  successCriteria: [
    { id: "c", description: "c", evaluator: { type: "human_confirmation" as const } },
  ],
  completionPolicy: "automatic" as const,
};

const basePlan: ExecutionPlan = {
  id: "p",
  version: 1,
  goal,
  steps: [
    {
      id: "a",
      executor: { type: "human" },
      after: [],
      requirements: ["stove"],
      estimatedDurationSeconds: 10,
      timers: [],
      domainData: {},
    },
    {
      id: "b",
      executor: { type: "human" },
      after: [],
      requirements: ["stove"],
      estimatedDurationSeconds: 10,
      timers: [],
      domainData: {},
    },
    {
      id: "c",
      executor: { type: "human" },
      after: ["a", "b"],
      requirements: [],
      estimatedDurationSeconds: 5,
      timers: [],
      domainData: {},
    },
  ],
};

describe("schedulePlan", () => {
  it("levels exclusive stove capacity so parallel steps do not overlap", () => {
    const result = schedulePlan(basePlan, {
      capacities: [{ id: "stove", capacity: 1, mode: "exclusive" }],
    });
    const a = result.plan.steps.find((s) => s.id === "a")!.timeline!;
    const b = result.plan.steps.find((s) => s.id === "b")!.timeline!;
    const c = result.plan.steps.find((s) => s.id === "c")!.timeline!;

    // One of a/b starts at 0, the other at 10.
    const starts = [a.startOffsetSeconds, b.startOffsetSeconds].sort((x, y) => x - y);
    expect(starts).toEqual([0, 10]);
    expect(c.startOffsetSeconds).toBe(20);
    expect(result.conflicts).toEqual([]);
  });

  it("reports conflicts when resolveCapacity is false", () => {
    const result = schedulePlan(basePlan, {
      capacities: [{ id: "stove", capacity: 1 }],
      resolveCapacity: false,
    });
    expect(result.conflicts.length).toBeGreaterThan(0);
  });
});
