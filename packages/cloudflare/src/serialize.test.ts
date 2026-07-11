import { createWorldState } from "@pear-agent/core";
import { describe, expect, it } from "vitest";

import { parseExecutionState, serializeExecutionState } from "./serialize.js";
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
      domainData: { label: "one", createdAt: "2026-07-11T03:00:00.000Z" },
    },
  ],
};

describe("serialize", () => {
  it("round-trips MaterializedExecutionState Core dates through JSON", () => {
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

  it("keeps Domain fact ISO strings under Core date key names as strings", () => {
    const state = buildInitialExecutionState({
      sessionId: "session-2",
      plan,
      actorIds: ["actor-1"],
      now: new Date("2026-07-11T00:00:00.000Z"),
      worldState: createWorldState({
        updatedAt: new Date("2026-07-11T00:00:00.000Z"),
        facts: {
          nested: { createdAt: "2026-07-11T03:00:00.000Z", note: "keep string" },
        },
      }),
    });

    const restored = parseExecutionState(serializeExecutionState(state));
    const nested = restored.worldState.facts.nested as {
      createdAt: string;
      note: string;
    };
    expect(typeof nested.createdAt).toBe("string");
    expect(nested.createdAt).toBe("2026-07-11T03:00:00.000Z");
    expect(nested.note).toBe("keep string");
    expect(restored.session.createdAt).toBeInstanceOf(Date);
  });

  it("keeps Domain domainData ISO strings under createdAt as strings", () => {
    const restored = parseExecutionState(
      serializeExecutionState(
        buildInitialExecutionState({
          sessionId: "session-3",
          plan,
          actorIds: ["actor-1"],
          now: new Date("2026-07-11T00:00:00.000Z"),
        }),
      ),
    );
    const domainData = restored.plan.steps[0]?.domainData as {
      label: string;
      createdAt: string;
    };
    expect(typeof domainData.createdAt).toBe("string");
    expect(domainData.createdAt).toBe("2026-07-11T03:00:00.000Z");
  });
});
