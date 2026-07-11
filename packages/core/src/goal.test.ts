import { describe, expect, it } from "vitest";

import { evaluateGoalCompletion, executionGoalSchema } from "./goal.js";

describe("evaluateGoalCompletion", () => {
  it("is incomplete when any criterion evaluation is unknown", () => {
    const now = new Date();

    expect(
      evaluateGoalCompletion([
        { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
        { criterionId: "charged", status: "unknown", evidence: [], evaluatedAt: now },
      ]),
    ).toBe("incomplete");
  });

  it("is incomplete when there are no criterion evaluations", () => {
    expect(evaluateGoalCompletion([])).toBe("incomplete");
  });

  it("is incomplete when any criterion is unsatisfied", () => {
    const now = new Date();

    expect(
      evaluateGoalCompletion([
        { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
        { criterionId: "charged", status: "unsatisfied", evidence: [], evaluatedAt: now },
      ]),
    ).toBe("incomplete");
  });

  it("is satisfied when every criterion is satisfied", () => {
    const now = new Date();

    expect(
      evaluateGoalCompletion([
        { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
        { criterionId: "charged", status: "satisfied", evidence: [], evaluatedAt: now },
      ]),
    ).toBe("satisfied");
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
