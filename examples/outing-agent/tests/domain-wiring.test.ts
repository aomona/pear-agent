import { describe, expect, it } from "vitest";

import {
  assessOutingDelayReplan,
  buildOutingDelayPatch,
  buildOutingPlan,
  buildOutingWorldState,
  outingDomain,
  outingGoal,
} from "@pear-agent/outing-domain-example";

describe("outing-agent domain wiring", () => {
  it("builds plan, world state, and delay patch for sample input", async () => {
    const normalized = await outingDomain.normalizeInput({
      departureAt: "2026-08-20T10:00:00Z",
      belongings: [
        { id: "keys", name: "Keys" },
        { id: "phone", name: "Phone", chargePercent: 30 },
      ],
    });
    const plan = buildOutingPlan(normalized);
    expect(plan.goal).toEqual(outingGoal);
    expect(plan.steps.map((s) => s.id)).toEqual(["pack", "charge"]);

    const world = buildOutingWorldState(normalized);
    expect(world.facts.departureAt).toBe("2026-08-20T10:00:00Z");

    const assessment = assessOutingDelayReplan({
      recentEvents: [
        {
          id: "e1",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 10 },
        },
      ],
    });
    expect(assessment.needsReplan).toBe(true);

    const patch = buildOutingDelayPatch({
      plan,
      assessment,
      affectedStepIds: assessment.directlyAffectedStepIds,
      recentEvents: [
        {
          id: "e1",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 10 },
        },
      ],
      patchId: "p1",
    });
    expect(patch.operations[0]?.type).toBe("update_step");
  });
});
