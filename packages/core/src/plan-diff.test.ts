import { describe, expect, it } from "vitest";

import { diffPlans } from "./plan-diff.js";
import type { ExecutionPlan } from "./plan.js";

const goal = {
  id: "g",
  description: "goal",
  successCriteria: [
    { id: "c", description: "c", evaluator: { type: "human_confirmation" as const } },
  ],
  completionPolicy: "automatic" as const,
};

const before: ExecutionPlan = {
  id: "p",
  version: 1,
  goal,
  steps: [
    {
      id: "pack",
      label: "Pack",
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 60,
      timers: [],
      domainData: {},
    },
  ],
};

describe("diffPlans", () => {
  it("detects added, removed, and updated steps", () => {
    const after: ExecutionPlan = {
      ...before,
      version: 2,
      steps: [
        {
          id: "pack",
          label: "Pack carefully",
          executor: { type: "human" },
          after: [],
          requirements: [],
          estimatedDurationSeconds: 90,
          timers: [],
          domainData: {},
        },
        {
          id: "charge",
          executor: { type: "human" },
          after: ["pack"],
          requirements: [],
          estimatedDurationSeconds: 300,
          timers: [],
          domainData: {},
        },
      ],
    };

    const diff = diffPlans(before, after);
    expect(diff.addedStepIds).toEqual(["charge"]);
    expect(diff.removedStepIds).toEqual([]);
    expect(diff.updatedStepIds).toContain("pack");
    expect(diff.fieldChanges.some((c) => c.field === "label")).toBe(true);
    expect(diff.durationDeltaSeconds).toBe(330);
  });
});
