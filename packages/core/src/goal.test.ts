import { describe, expect, it } from "vitest";

import { evaluateGoalCompletion, executionGoalSchema } from "./goal.js";

describe("evaluateGoalCompletion", () => {
  const goal = executionGoalSchema.parse({
    id: "leave-home",
    description: "Be ready to leave home",
    successCriteria: [
      { id: "packed", description: "Bag is packed", evaluator: { type: "state_rule" } },
      { id: "charged", description: "Phone is charged", evaluator: { type: "state_rule" } },
    ],
    completionPolicy: "automatic",
  });

  it("is incomplete when any criterion evaluation is unknown", () => {
    const now = new Date();

    expect(
      evaluateGoalCompletion(goal, [
        { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
        { criterionId: "charged", status: "unknown", evidence: [], evaluatedAt: now },
      ]),
    ).toBe("incomplete");
  });

  it("is incomplete when there are no criterion evaluations", () => {
    expect(evaluateGoalCompletion(goal, [])).toBe("incomplete");
  });

  it("is incomplete when any criterion is unsatisfied", () => {
    const now = new Date();

    expect(
      evaluateGoalCompletion(goal, [
        { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
        { criterionId: "charged", status: "unsatisfied", evidence: [], evaluatedAt: now },
      ]),
    ).toBe("incomplete");
  });

  it("is satisfied when every criterion is satisfied", () => {
    const now = new Date();

    expect(
      evaluateGoalCompletion(goal, [
        { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
        { criterionId: "charged", status: "satisfied", evidence: [], evaluatedAt: now },
      ]),
    ).toBe("satisfied");
  });

  it("is incomplete when a criterion evaluation is missing", () => {
    const now = new Date();
    expect(
      evaluateGoalCompletion(goal, [
        { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
      ]),
    ).toBe("incomplete");
  });

  it("is incomplete when a criterion is evaluated more than once", () => {
    const now = new Date();
    expect(
      evaluateGoalCompletion(goal, [
        { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
        { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
      ]),
    ).toBe("incomplete");
  });

  it("is incomplete when an unknown criterion is evaluated", () => {
    const now = new Date();
    expect(
      evaluateGoalCompletion(goal, [
        { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
        { criterionId: "unknown", status: "satisfied", evidence: [], evaluatedAt: now },
      ]),
    ).toBe("incomplete");
  });
});

describe("executionGoalSchema", () => {
  it("rejects a goal without success criteria", () => {
    expect(() =>
      executionGoalSchema.parse({
        id: "leave-home",
        description: "Be ready to leave home",
        successCriteria: [],
        completionPolicy: "automatic",
      }),
    ).toThrow();
  });
});
