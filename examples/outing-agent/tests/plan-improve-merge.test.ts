import { describe, expect, it } from "vitest";

import { outingPlan } from "@pear-agent/outing-domain-example";

import { applyPlanImproveEdits } from "../worker/src/plan-improver.js";

describe("applyPlanImproveEdits", () => {
  it("merges label and duration onto existing steps", () => {
    const next = applyPlanImproveEdits(outingPlan, {
      title: "Faster prep",
      steps: [
        {
          id: "pack",
          label: "Quick pack",
          estimatedDurationSeconds: 30,
        },
        {
          id: "charge",
          estimatedDurationSeconds: 120,
          instructions: "Plug in phone only",
        },
      ],
    });

    expect(next.title).toBe("Faster prep");
    const pack = next.steps.find((s) => s.id === "pack");
    const charge = next.steps.find((s) => s.id === "charge");
    expect(pack?.label).toBe("Quick pack");
    expect(pack?.estimatedDurationSeconds).toBe(30);
    expect(charge?.estimatedDurationSeconds).toBe(120);
    expect(charge?.instructions).toBe("Plug in phone only");
    const chargeWait = charge?.timers.find((t) => t.id === "charge-wait");
    expect(chargeWait?.durationSeconds).toBe(120);
  });

  it("ignores unknown step ids", () => {
    const next = applyPlanImproveEdits(outingPlan, {
      steps: [{ id: "unknown", label: "Nope" }],
    });
    expect(next.steps.map((s) => s.id)).toEqual(outingPlan.steps.map((s) => s.id));
    expect(next.steps.find((s) => s.id === "pack")?.label).toBe(outingPlan.steps[0]?.label);
  });
});
