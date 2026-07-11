import { describe, expect, it } from "vitest";

import { parseExecutionState, reviveJsonDates, serializeExecutionState } from "./serialize.js";
import { buildInitialExecutionState } from "./session/build-initial-state.js";

const plan = {
  id: "plan-1",
  version: 1,
  goal: {
    id: "goal-1",
    description: "done",
    successCriteria: [
      { id: "c1", description: "c1", evaluator: { type: "human_confirmation" as const } },
    ],
    completionPolicy: "human_confirmation" as const,
  },
  steps: [
    {
      id: "s1",
      executor: { type: "human" as const },
      after: [] as string[],
      requirements: [] as string[],
      estimatedDurationSeconds: 1,
      timers: [] as unknown[],
      domainData: { label: "one" },
    },
  ],
};

describe("serialize", () => {
  it("round-trips MaterializedExecutionState dates through JSON", () => {
    const state = buildInitialExecutionState({
      sessionId: "session-1",
      plan,
      actorIds: ["actor-1"],
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    const restored = parseExecutionState(serializeExecutionState(state));
    expect(restored.session.createdAt).toEqual(state.session.createdAt);
    expect(restored.worldState.updatedAt).toEqual(state.worldState.updatedAt);
    expect(restored.plan.steps[0]?.id).toBe("s1");
  });

  it("revives Core date fields without rewriting nested domain-shaped strings under other keys", () => {
    const revived = reviveJsonDates({
      deadline: "2026-07-11T03:00:00.000Z",
      departureAt: "2026-07-11T03:00:00Z",
      nested: { createdAt: "2026-07-11T00:00:00.000Z", label: "keep" },
    }) as {
      deadline: Date;
      departureAt: string;
      nested: { createdAt: Date; label: string };
    };
    expect(revived.deadline).toBeInstanceOf(Date);
    expect(revived.departureAt).toBe("2026-07-11T03:00:00Z");
    expect(revived.nested.createdAt).toBeInstanceOf(Date);
    expect(revived.nested.label).toBe("keep");
  });
});
