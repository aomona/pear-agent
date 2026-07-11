import { describe, expect, it } from "vitest";

import { executionTimerSchema } from "./timer.js";

describe("executionTimerSchema", () => {
  it("requires duration, remaining time, and timestamps", () => {
    const now = new Date("2026-07-11T00:00:00.000Z");
    expect(
      executionTimerSchema.parse({
        id: "tea",
        status: "running",
        durationSeconds: 60,
        remainingSeconds: 60,
        startedAt: now,
        endsAt: new Date(now.getTime() + 60_000),
      }),
    ).toMatchObject({ id: "tea", status: "running" });
    expect(executionTimerSchema.safeParse({ id: "tea", status: "running" }).success).toBe(false);
  });
});
