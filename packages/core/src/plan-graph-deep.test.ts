import { describe, expect, it } from "vitest";

import {
  computeCriticalPathIds,
  estimateCriticalPathDurationSeconds,
  topologicalDepths,
} from "./plan-graph.js";
import { buildPlanPresentation } from "./plan-presentation.js";
import type { ExecutionPlan } from "./plan.js";

const goal = {
  id: "g",
  description: "goal",
  successCriteria: [
    { id: "c", description: "c", evaluator: { type: "human_confirmation" as const } },
  ],
  completionPolicy: "automatic" as const,
};

describe("deep linear chain (2000 steps)", () => {
  const count = 2000;
  const steps = Array.from({ length: count }, (_, index) => ({
    id: `step-${index}`,
    executor: { type: "human" as const },
    after: index > 0 ? [`step-${index - 1}`] : [],
    requirements: [],
    estimatedDurationSeconds: 10,
    timers: [],
    domainData: {},
  }));
  const plan: ExecutionPlan = { id: "p", version: 1, goal, steps };

  it("topologicalDepths handles deep linear chain without stack overflow", () => {
    const depths = topologicalDepths(plan.steps);
    expect(depths.get("step-0")).toBe(0);
    expect(depths.get("step-1999")).toBe(1999);
    expect(depths.size).toBe(count);
  });

  it("estimateCriticalPathDurationSeconds handles deep linear chain without stack overflow", () => {
    const duration = estimateCriticalPathDurationSeconds(plan.steps);
    // 2000 steps × 10 seconds each in a linear chain
    expect(duration).toBe(2000 * 10);
  });

  it("computeCriticalPathIds handles deep linear chain without stack overflow", () => {
    const path = computeCriticalPathIds(plan.steps);
    expect(path).toEqual(steps.map((s) => s.id));
    expect(path).toHaveLength(count);
  });

  it("buildPlanPresentation handles deep linear chain without stack overflow", () => {
    const presentation = buildPlanPresentation(plan);
    expect(presentation.totalDurationSeconds).toBe(2000 * 10);
    expect(presentation.criticalPath).toHaveLength(count);
    expect(presentation.lanes).toHaveLength(count);
    expect(presentation.lanes[0]).toEqual(["step-0"]);
    expect(presentation.lanes[count - 1]).toEqual(["step-1999"]);
  });
});
