import { describe, expect, it } from "vitest";

import { starterDomain } from "../src/domain/domain";

describe("starter AI domain", () => {
  it("keeps deterministic validation around AI plans", async () => {
    const result = await starterDomain.planning.validatePlan({
      id: "plan",
      version: 1,
      goal: { id: "goal", description: "Ship", successCriteria: [], completionPolicy: "automatic" },
      steps: [],
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain("Plan must contain steps");
  });
});
