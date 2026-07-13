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
    expect(c.endOffsetSeconds).toBe(25);
    // Makespan includes resource leveling, not dep-only critical path (15s).
    expect(result.totalDurationSeconds).toBe(25);
    expect(result.conflicts).toEqual([]);
  });

  it("reports conflicts when resolveCapacity is false", () => {
    const result = schedulePlan(basePlan, {
      capacities: [{ id: "stove", capacity: 1 }],
      resolveCapacity: false,
    });
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it("throws when a step requires more than resource capacity", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      steps: [
        {
          id: "heavy",
          executor: { type: "human" },
          after: [],
          requirements: [],
          resourceRequirements: [{ resourceId: "stove", quantity: 2 }],
          estimatedDurationSeconds: 10,
          timers: [],
          domainData: {},
        },
      ],
    };
    expect(() =>
      schedulePlan(plan, {
        capacities: [{ id: "stove", capacity: 1, mode: "exclusive" }],
      }),
    ).toThrow(/requires 2 of stove but capacity is 1/);
  });

  it("aggregates duplicate legacy requirements before checking capacity", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      steps: [
        {
          ...basePlan.steps[0]!,
          id: "duplicate",
          requirements: ["stove", "stove"],
        },
      ],
    };

    expect(() => schedulePlan(plan, { capacities: [{ id: "stove", capacity: 1 }] })).toThrow(
      /requires 2 of stove but capacity is 1/,
    );
  });

  it("keeps zero-duration timelines valid", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      steps: [{ ...basePlan.steps[0]!, id: "instant", estimatedDurationSeconds: 0 }],
    };

    const result = schedulePlan(plan);
    expect(result.plan.steps[0]?.timeline).toEqual({
      startOffsetSeconds: 0,
      endOffsetSeconds: 0,
    });
  });

  it("handles many parallel steps competing for an exclusive resource (fast convergence)", () => {
    const parallelCount = 500;
    const steps = Array.from({ length: parallelCount }, (_, i) => ({
      id: `s-${i}`,
      executor: { type: "human" as const },
      after: [],
      requirements: [],
      resourceRequirements: [{ resourceId: "r", quantity: 1 }],
      estimatedDurationSeconds: 1,
      timers: [],
      domainData: {},
    }));
    const plan: ExecutionPlan = {
      ...basePlan,
      steps,
    };
    const result = schedulePlan(plan, {
      capacities: [{ id: "r", mode: "exclusive", capacity: 1 }],
    });
    expect(result.conflicts).toEqual([]);
    // Each step gets its own slot; makespan = parallelCount (1 per step).
    expect(result.totalDurationSeconds).toBe(parallelCount);
  });

  // NOTE: The inner function findEarliestStart has a hard limit of 10,000 scheduling
  // attempts per step. Previously the loop silently returned `start` (potentially invalid)
  // when exhausted. Now it throws: `Cannot schedule step ${stepId}: resource leveling
  // did not converge after 10,000 attempts`.
  //
  // A test that triggers this throw requires >= 10,001 independent steps all competing
  // for the same exclusive resource (so the final step must slide past 10,001 intervals).
  // Scheduling N such steps costs O(N²) total attempts — ~50M attempts for N=10,001 —
  // which is too slow for a unit test (estimated >> 30s). The code change is a
  // straightforward s/return start/throw new Error()/ verified by inspection.

  it("reports capacity-exceeding requirements as conflicts when not resolving", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      steps: [
        {
          id: "heavy",
          executor: { type: "human" },
          after: [],
          requirements: [],
          resourceRequirements: [{ resourceId: "stove", quantity: 2 }],
          estimatedDurationSeconds: 10,
          timers: [],
          domainData: {},
        },
      ],
    };
    const result = schedulePlan(plan, {
      capacities: [{ id: "stove", capacity: 1 }],
      resolveCapacity: false,
    });
    expect(result.conflicts).toEqual([
      {
        stepId: "heavy",
        resourceId: "stove",
        atOffsetSeconds: 0,
        needed: 2,
        available: 1,
      },
    ]);
  });
});
