import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createWorldState,
  createWorldStateFromDomainFacts,
  parseDomainWorldStateFacts,
  worldStateSchema,
} from "./world-state.js";

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

describe("createWorldState", () => {
  it("fills empty collections when only updatedAt and facts are provided", () => {
    const updatedAt = new Date("2026-07-11T00:00:00.000Z");
    expect(
      createWorldState({
        facts: { packedItemIds: ["keys"] },
        updatedAt,
      }),
    ).toEqual({
      facts: { packedItemIds: ["keys"] },
      resources: [],
      observations: [],
      activeConstraints: [],
      updatedAt,
    });
  });
});

describe("domain worldState facts contract", () => {
  const domainFactsSchema = z.object({
    packedItemIds: z.array(z.string()),
    departureAt: z.iso.datetime(),
  });

  it("builds a runtime WorldState envelope from domain facts", () => {
    const updatedAt = new Date("2026-07-11T00:00:00.000Z");
    const worldState = createWorldStateFromDomainFacts(
      domainFactsSchema,
      { packedItemIds: ["keys"], departureAt: "2026-07-11T03:00:00Z" },
      { updatedAt },
    );

    expect(worldState.facts).toEqual({
      packedItemIds: ["keys"],
      departureAt: "2026-07-11T03:00:00Z",
    });
    expect(parseDomainWorldStateFacts(domainFactsSchema, worldState)).toEqual({
      packedItemIds: ["keys"],
      departureAt: "2026-07-11T03:00:00Z",
    });
  });

  it("rejects domain facts that do not match the domain schema", () => {
    expect(() =>
      createWorldStateFromDomainFacts(
        domainFactsSchema,
        { packedItemIds: "keys", departureAt: "2026-07-11T03:00:00Z" } as never,
        { updatedAt: new Date() },
      ),
    ).toThrow();
  });

  it("rejects reading facts that do not match the domain schema", () => {
    const worldState = createWorldState({
      facts: { packedItemIds: "not-an-array" },
      updatedAt: new Date(),
    });
    expect(() => parseDomainWorldStateFacts(domainFactsSchema, worldState)).toThrow();
  });
});
