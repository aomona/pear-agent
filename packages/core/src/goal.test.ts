import { describe, expect, it } from "vitest";

import {
  criterionEvaluationSchema,
  evaluateGoalCompletion,
  executionGoalSchema,
  latestCriterionEvaluations,
} from "./goal.js";

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

  it("projects only expected criteria for completion decisions", () => {
    const now = new Date();
    const projected = latestCriterionEvaluations(goal, {
      packed: { criterionId: "packed", status: "satisfied", evidence: [], evaluatedAt: now },
      charged: { criterionId: "charged", status: "satisfied", evidence: [], evaluatedAt: now },
      unknown: { criterionId: "unknown", status: "satisfied", evidence: [], evaluatedAt: now },
    });
    expect(projected.map(({ criterionId }) => criterionId)).toEqual(["packed", "charged"]);
    expect(evaluateGoalCompletion(goal, projected)).toBe("satisfied");
  });
});

describe("criterionEvaluationSchema", () => {
  it("rejects non-JSON-safe evidence", () => {
    expect(
      criterionEvaluationSchema.safeParse({
        criterionId: "packed",
        status: "satisfied",
        evidence: [() => true],
        evaluatedAt: new Date(),
      }).success,
    ).toBe(false);
  });

  it("accepts JSON-safe evidence", () => {
    expect(
      criterionEvaluationSchema.safeParse({
        criterionId: "packed",
        status: "satisfied",
        evidence: ["note", { count: 1 }, null],
        evaluatedAt: new Date(),
      }).success,
    ).toBe(true);
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

  it("rejects duplicate successCriteria ids", () => {
    expect(() =>
      executionGoalSchema.parse({
        id: "leave-home",
        description: "Be ready to leave home",
        successCriteria: [
          { id: "packed", description: "Bag is packed", evaluator: { type: "state_rule" } },
          { id: "packed", description: "Bag is packed again", evaluator: { type: "state_rule" } },
        ],
        completionPolicy: "automatic",
      }),
    ).toThrow();
  });

  it("accepts a goal with unique successCriteria ids", () => {
    expect(
      executionGoalSchema.safeParse({
        id: "leave-home",
        description: "Be ready to leave home",
        successCriteria: [
          { id: "packed", description: "Bag is packed", evaluator: { type: "state_rule" } },
          { id: "charged", description: "Phone is charged", evaluator: { type: "state_rule" } },
        ],
        completionPolicy: "automatic",
      }).success,
    ).toBe(true);
  });
});
