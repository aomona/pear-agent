import { describe, expect, it } from "vitest";

import { outingDomain } from "./domain.js";

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

  it("accepts a delay event", () => {
    expect(outingDomain.schemas.events.parse({ type: "delay", minutes: 15 })).toEqual({
      type: "delay",
      minutes: 15,
    });
  });
});
