import { describe, expect, it } from "vitest";

import { executionSessionSchema } from "./session.js";

describe("executionSessionSchema", () => {
  const session = {
    id: "session-1",
    planId: "plan-1",
    planVersion: 1,
    goalId: "goal-1",
    status: "active",
    actorIds: ["human-1"],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("accepts an active execution session", () => {
    expect(executionSessionSchema.safeParse(session).success).toBe(true);
  });

  it("rejects a session without actors", () => {
    expect(executionSessionSchema.safeParse({ ...session, actorIds: [] }).success).toBe(false);
  });

  it("rejects an unknown session status", () => {
    expect(executionSessionSchema.safeParse({ ...session, status: "archived" }).success).toBe(false);
  });
});
