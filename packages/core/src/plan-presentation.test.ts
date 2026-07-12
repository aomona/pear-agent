import { describe, expect, it } from "vitest";

import { buildPlanPresentation } from "./plan-presentation.js";
import type { ExecutionPlan } from "./plan.js";

const goal = {
  id: "ready",
  description: "Be ready",
  successCriteria: [
    { id: "ok", description: "ok", evaluator: { type: "human_confirmation" as const } },
  ],
  completionPolicy: "automatic" as const,
};

const plan: ExecutionPlan = {
  id: "p1",
  version: 1,
  title: "Morning outing",
  goal,
  steps: [
    {
      id: "pack",
      label: "Pack bag",
      instructions: "Put keys and wallet in the bag",
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 60,
      timers: [],
      domainData: {},
    },
    {
      id: "charge",
      label: "Charge phone",
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 300,
      timers: [{ id: "charge-wait", durationSeconds: 300, autoStart: true }],
      domainData: {},
    },
    {
      id: "leave",
      label: "Leave",
      executor: { type: "human" },
      after: ["pack", "charge"],
      requirements: [],
      estimatedDurationSeconds: 30,
      timers: [],
      domainData: {},
    },
  ],
};

describe("buildPlanPresentation", () => {
  it("builds lanes by topological depth and a critical path", () => {
    const presentation = buildPlanPresentation(plan, {
      pack: { status: "ready" },
      charge: { status: "ready" },
      leave: { status: "blocked" },
    });

    expect(presentation.title).toBe("Morning outing");
    expect(presentation.lanes[0]).toEqual(expect.arrayContaining(["pack", "charge"]));
    expect(presentation.lanes[1]).toEqual(["leave"]);
    expect(presentation.edges).toEqual(
      expect.arrayContaining([
        { from: "pack", to: "leave" },
        { from: "charge", to: "leave" },
      ]),
    );
    expect(presentation.totalDurationSeconds).toBe(330);
    expect(presentation.criticalPath).toEqual(["charge", "leave"]);
    expect(presentation.readyIds).toEqual(expect.arrayContaining(["pack", "charge"]));
    expect(presentation.blockedIds).toEqual(["leave"]);
    expect(presentation.nodes.find((n) => n.id === "pack")?.label).toBe("Pack bag");
    expect(presentation.nodes.find((n) => n.id === "pack")?.instructions).toBe(
      "Put keys and wallet in the bag",
    );
  });

  it("falls back to goal description when title is omitted", () => {
    const { title, ...withoutTitle } = plan;
    void title;
    expect(buildPlanPresentation(withoutTitle).title).toBe("Be ready");
  });
});
