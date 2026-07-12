import { describe, expect, it } from "vitest";

import { assertPlanMatchesGoal, evaluateAllCriteria } from "./goal.js";
import type { ExecutionGoal } from "./goal.js";

const goal: ExecutionGoal = {
  id: "ready",
  description: "Ready",
  successCriteria: [
    { id: "packed", description: "Packed", evaluator: { type: "state_rule" } },
    { id: "charged", description: "Charged", evaluator: { type: "state_rule" } },
  ],
  completionPolicy: "automatic",
};

describe("assertPlanMatchesGoal", () => {
  it("accepts matching goal ids and criteria", () => {
    expect(
      assertPlanMatchesGoal(
        {
          goal: {
            ...goal,
            description: "other wording ok",
          },
        },
        goal,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects id mismatch", () => {
    expect(assertPlanMatchesGoal({ goal: { ...goal, id: "other" } }, goal).ok).toBe(false);
  });
});

describe("evaluateAllCriteria", () => {
  it("invokes evaluator per criterion", async () => {
    const now = new Date("2026-07-12T00:00:00.000Z");
    const evaluations = await evaluateAllCriteria(
      {
        evaluateCriterion: (id) => ({
          criterionId: id,
          status: id === "packed" ? "satisfied" : "unsatisfied",
          evidence: [],
          evaluatedAt: now,
        }),
      },
      { goal, plan: {}, worldState: {}, stepStates: {}, now },
    );
    expect(evaluations).toHaveLength(2);
    expect(evaluations.map((e) => e.status)).toEqual(["satisfied", "unsatisfied"]);
  });
});
