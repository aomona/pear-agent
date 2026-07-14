import { describe, expect, it } from "vitest";

import { starterDomain } from "../src/domain/domain";
import { buildStarterGoal, buildStarterPlan } from "../src/domain/plan";

describe("starter domain", () => {
  it("normalizes input and builds sequential work", async () => {
    const input = await starterDomain.normalizeInput({
      title: "Ship the demo",
      tasks: ["Review", "Deploy"],
    });
    const plan = buildStarterPlan(buildStarterGoal(input.title), input);

    expect(plan.steps.map(({ label }) => label)).toEqual(["Review", "Deploy"]);
    expect(plan.steps[1]?.after).toEqual(["task-1"]);
  });
});
