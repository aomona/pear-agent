import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  executionPlanSchema,
  executionStepSchema,
  validatePlanGraph,
  wakeConditionSchema,
} from "./plan.js";

describe("validatePlanGraph", () => {
  it("rejects a cycle", () => {
    expect(
      validatePlanGraph([
        { id: "a", after: ["b"] },
        { id: "b", after: ["a"] },
      ]),
    ).toEqual({ valid: false, reason: "cycle" });
  });

  it("accepts a valid DAG", () => {
    expect(
      validatePlanGraph([
        { id: "prepare", after: [] },
        { id: "leave", after: ["prepare"] },
      ]),
    ).toEqual({ valid: true });
  });

  it("rejects duplicate step IDs", () => {
    expect(
      validatePlanGraph([
        { id: "prepare", after: [] },
        { id: "prepare", after: [] },
      ]),
    ).toEqual({ valid: false, reason: "duplicate_id" });
  });

  it("rejects a missing dependency", () => {
    expect(validatePlanGraph([{ id: "leave", after: ["prepare"] }])).toEqual({
      valid: false,
      reason: "missing_dependency",
    });
  });

  it("accepts a deep linear DAG without overflowing the stack", () => {
    const nodes = Array.from({ length: 50_000 }, (_value, index) => ({
      id: `step-${index}`,
      after: index > 0 ? [`step-${index - 1}`] : [],
    }));

    expect(validatePlanGraph(nodes)).toEqual({ valid: true });
  });

  it("detects a cycle at the end of a deep chain", () => {
    const length = 50_000;
    const nodes = Array.from({ length }, (_value, index) => ({
      id: `step-${index}`,
      after: index > 0 ? [`step-${index - 1}`] : [`step-${length - 1}`],
    }));

    expect(validatePlanGraph(nodes)).toEqual({ valid: false, reason: "cycle" });
  });
});

describe("wakeConditionSchema", () => {
  it("accepts an ISO datetime wakeAt", () => {
    expect(
      wakeConditionSchema.safeParse({ type: "time", wakeAt: "2026-07-11T12:00:00Z" }).success,
    ).toBe(true);
  });

  it("rejects a malformed wakeAt timestamp", () => {
    for (const wakeAt of ["tomorrow", "not-a-date", "2026-07-11", ""]) {
      expect(wakeConditionSchema.safeParse({ type: "time", wakeAt }).success).toBe(false);
    }
  });
});

describe("execution plan schemas", () => {
  const domainDataSchema = z.object({ room: z.string() });
  const goal = {
    id: "leave-home",
    description: "Be ready to leave home",
    successCriteria: [
      {
        id: "ready",
        description: "Ready",
        evaluator: { type: "human_confirmation" as const },
      },
    ],
    completionPolicy: "automatic" as const,
  };

  it("parses human, agent, and wait execution steps with domain data", () => {
    const schema = executionStepSchema(domainDataSchema);
    const common = {
      after: [],
      requirements: [],
      estimatedDurationSeconds: 60,
      timers: [],
      domainData: { room: "entryway" },
    };

    expect(schema.safeParse({ ...common, id: "human", executor: { type: "human" } }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({
        ...common,
        id: "agent",
        executor: { type: "agent", capabilityId: "send-reminder" },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...common,
        id: "wait",
        executor: { type: "wait", wakeCondition: { type: "time", wakeAt: "2026-07-11T12:00:00Z" } },
      }).success,
    ).toBe(true);
  });

  it("parses an execution plan and validates its graph", () => {
    const schema = executionPlanSchema(domainDataSchema);
    const result = schema.safeParse({
      id: "morning",
      version: 1,
      goal,
      steps: [
        {
          id: "prepare",
          executor: { type: "human" },
          after: [],
          requirements: ["bag"],
          estimatedDurationSeconds: 60,
          timers: [],
          domainData: { room: "entryway" },
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});
