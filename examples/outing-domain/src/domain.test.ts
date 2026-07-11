import { describe, expect, it } from "vitest";

import {
  executionPlanSchema,
  parseDomainEvent,
  parseDomainWorldStateFacts,
  worldStateSchema,
} from "@pear-agent/core";

import { initialOutingWorldState, outingDomain, outingGoal, outingPlan } from "./domain.js";

describe("outingDomain", () => {
  it("normalizes departure time, belongings, and charge state", async () => {
    await expect(
      outingDomain.normalizeInput({
        departureAt: "2026-07-11T03:00:00Z",
        belongings: [
          { id: "phone", name: "Phone", chargePercent: 80 },
          { id: "keys", name: "Keys" },
        ],
      }),
    ).resolves.toEqual({
      departureAt: "2026-07-11T03:00:00Z",
      belongings: [
        { id: "phone", name: "Phone", chargePercent: 80 },
        { id: "keys", name: "Keys", chargePercent: null },
      ],
    });
  });

  it("accepts a delay event via domain schema and runtime domain_event mapping", () => {
    expect(outingDomain.schemas.events.parse({ type: "delay", minutes: 15 })).toEqual({
      type: "delay",
      minutes: 15,
    });
    expect(
      parseDomainEvent(outingDomain.schemas.events, {
        domainType: "delay",
        payload: { minutes: 15 },
      }),
    ).toEqual({ type: "delay", minutes: 15 });
  });

  it("provides a valid execution goal, parallel plan, and domain facts in WorldState", () => {
    expect(executionPlanSchema(outingDomain.schemas.stepData).parse(outingPlan).goal).toEqual(
      outingGoal,
    );
    expect(outingPlan.steps.map(({ after, id }) => ({ after, id }))).toEqual([
      { id: "pack", after: [] },
      { id: "charge", after: [] },
    ]);
    expect(worldStateSchema.parse(initialOutingWorldState)).toEqual(initialOutingWorldState);
    expect(
      parseDomainWorldStateFacts(outingDomain.schemas.worldState, initialOutingWorldState),
    ).toEqual({
      departureAt: "2026-07-11T03:00:00Z",
      packedBelongingIds: [],
      chargeByBelongingId: { phone: 20 },
    });
  });
});
