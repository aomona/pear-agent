import { describe, expect, it } from "vitest";
import { cookDomain } from "./index.js";

describe("cookDomain", () => {
  it("requires a sourced serve step for every dish", async () => {
    const result = await cookDomain.planning.validatePlan(
      {
        id: "p",
        version: 1,
        goal: {
          id: "g",
          description: "Dinner",
          successCriteria: [],
          completionPolicy: "automatic",
        },
        steps: [],
      },
      {
        servings: 2,
        serveAt: "2026-07-15T19:00:00+09:00",
        equipment: [],
        dishes: [{ name: "Soup", ingredients: [], sourceIds: ["s"] }],
        constraints: [],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toContain("Missing serve step for Soup");
  });
});
