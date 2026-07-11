import { describe, expect, it } from "vitest";

import { worldStateSchema } from "./world-state.js";

describe("worldStateSchema", () => {
  it("accepts JSON-safe facts, resources, and observations", () => {
    expect(
      worldStateSchema.safeParse({
        facts: { weather: { condition: "sunny", temperature: 25 } },
        resources: [{ id: "kitchen", state: { occupied: false } }],
        observations: [{ type: "weather_checked", data: { source: "forecast" } }],
        activeConstraints: ["leave-by-noon"],
        updatedAt: new Date(),
      }).success,
    ).toBe(true);
  });
});
