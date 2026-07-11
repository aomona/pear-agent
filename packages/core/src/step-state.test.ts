import { describe, expect, test } from "vitest";

import {
  deriveStepStatuses,
  stepStateSchema,
  stepStatusSchema,
  transitionStep,
} from "./step-state.js";

describe("deriveStepStatuses", () => {
  const steps = [
    { id: "pack", after: [] },
    { id: "charge", after: [] },
    { id: "leave", after: ["pack", "charge"] },
  ];

  test("marks independent steps ready in parallel", () => {
    const states = deriveStepStatuses(steps, {});

    expect(states.pack?.status).toBe("ready");
    expect(states.charge?.status).toBe("ready");
    expect(states.leave?.status).toBe("blocked");
  });

  test("unblocks a step after every dependency is completed or skipped", () => {
    const states = deriveStepStatuses(steps, {
      pack: { status: "completed" },
      charge: { status: "skipped" },
      leave: { status: "blocked" },
    });

    expect(states.leave?.status).toBe("ready");
  });

  test.each(["completed", "skipped"] as const)("preserves the terminal %s status", (status) => {
    const states = deriveStepStatuses([{ id: "pack", after: [] }], { pack: { status } });

    expect(states.pack?.status).toBe(status);
  });
});

describe("transitionStep", () => {
  test("moves a ready step to active", () => {
    expect(transitionStep({ status: "ready" }, "active")).toEqual({ status: "active" });
  });

  test("rejects an invalid transition", () => {
    expect(() => transitionStep({ status: "blocked" }, "completed")).toThrow(
      "Invalid step transition: blocked -> completed",
    );
  });

  test.each(["completed", "skipped"] as const)("rejects transitions from %s", (status) => {
    expect(() => transitionStep({ status }, "active")).toThrow(
      `Invalid step transition: ${status} -> active`,
    );
  });
});

describe("step state schemas", () => {
  test("expose runtime validation for statuses and state data", () => {
    expect(stepStatusSchema.safeParse("paused").success).toBe(true);
    expect(stepStatusSchema.safeParse("pending").success).toBe(false);
    expect(stepStateSchema.parse({ status: "failed" })).toEqual({ status: "failed" });
  });
});
