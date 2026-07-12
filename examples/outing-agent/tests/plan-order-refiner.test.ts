import { describe, expect, it } from "vitest";

import { buildOutingPlan, type OutingNormalizedInput } from "@pear-agent/outing-domain-example";

import { applyPlanStepOrder } from "../worker/src/plan-order-refiner.js";

const baseInput: OutingNormalizedInput = {
  departureAt: "2026-07-12T01:00:00.000Z",
  belongings: [
    { id: "keys", name: "Keys", chargePercent: null },
    { id: "phone", name: "Phone", chargePercent: 20 },
  ],
  tasks: [{ id: "weather", title: "Check weather", estimatedDurationSeconds: 30, notes: null }],
  originLabel: "Home",
  destinationLabel: "Office",
};

describe("applyPlanStepOrder", () => {
  it("rewires after edges without changing step bodies", () => {
    const base = buildOutingPlan(baseInput);
    expect(base.steps.every((s) => s.after.length === 0)).toBe(true);

    const ordered = applyPlanStepOrder(base, {
      steps: [
        { id: "pack", after: [] },
        { id: "charge", after: [] },
        { id: "task:weather", after: ["pack"] },
      ],
    });

    expect(ordered.steps.find((s) => s.id === "task:weather")?.after).toEqual(["pack"]);
    expect(ordered.steps.find((s) => s.id === "pack")?.domainData).toEqual(
      base.steps.find((s) => s.id === "pack")?.domainData,
    );
  });

  it("rejects cycles and unknown ids", () => {
    const base = buildOutingPlan(baseInput);
    expect(() =>
      applyPlanStepOrder(base, {
        steps: [
          { id: "pack", after: ["charge"] },
          { id: "charge", after: ["pack"] },
          { id: "task:weather", after: [] },
        ],
      }),
    ).toThrow(/cycle|Invalid plan graph/i);

    expect(() =>
      applyPlanStepOrder(base, {
        steps: [
          { id: "pack", after: [] },
          { id: "charge", after: [] },
          { id: "nope", after: [] },
        ],
      }),
    ).toThrow(/Unknown step id/);
  });
});
