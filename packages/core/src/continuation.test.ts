import { describe, expect, it } from "vitest";

import { checkpointPlanVersionId, executionContinuationSchema } from "./continuation.js";

describe("ExecutionContinuation", () => {
  it("parses durable time wake checkpoints and coerces dates", () => {
    const parsed = executionContinuationSchema.parse({
      id: "cont-1",
      sessionId: "session-1",
      status: "suspended",
      wakeCondition: { type: "time", wakeAt: "2026-07-11T12:00:00Z" },
      suspendedReason: "Waiting for charging",
      resumeDirective: "Check the battery level",
      checkpointPlanVersionId: checkpointPlanVersionId("plan-1", 2),
      checkpointLastEventId: null,
      providerResumeHandle: null,
      schedulerId: null,
      createdAt: "2026-07-11T11:00:00Z",
      updatedAt: "2026-07-11T11:00:00Z",
    });

    expect(parsed.wakeCondition.type).toBe("time");
    if (parsed.wakeCondition.type === "time") {
      expect(parsed.wakeCondition.wakeAt).toBeInstanceOf(Date);
    }
    expect(parsed.checkpointPlanVersionId).toBe("plan-1:2");
  });
});
