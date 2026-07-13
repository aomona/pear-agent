import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  executionPlanSchema,
  executionStepSchema,
  timerDefinitionSchema,
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

  it("rejects non-JSON-safe domain data even when the domain schema is unknown", () => {
    const schema = executionStepSchema(z.unknown());
    const common = {
      id: "prepare",
      executor: { type: "human" as const },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 60,
      timers: [],
    };
    class DomainData {
      readonly room = "entryway";
    }

    for (const domainData of [() => "not cloneable", Symbol("not cloneable"), new DomainData()]) {
      expect(schema.safeParse({ ...common, domainData }).success).toBe(false);
    }
  });

  it("rejects non-JSON-safe domain data in execution plans", () => {
    const schema = executionPlanSchema(z.unknown());
    const step = {
      id: "prepare",
      executor: { type: "human" as const },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 60,
      timers: [],
    };
    const plan = {
      id: "morning",
      version: 1,
      goal,
      steps: [step],
    };

    for (const domainData of [() => "not cloneable", Symbol("not cloneable")]) {
      expect(schema.safeParse({ ...plan, steps: [{ ...step, domainData }] }).success).toBe(false);
    }
  });

  it("accepts optional presentation fields, title, metadata, and timer definitions", () => {
    const schema = executionPlanSchema(z.object({}));
    const result = schema.safeParse({
      id: "morning",
      version: 1,
      title: "Leave for work",
      metadata: { source: "demo" },
      goal,
      steps: [
        {
          id: "pack",
          label: "Pack",
          instructions: "Gather belongings",
          notes: ["Check weather"],
          executor: { type: "human" },
          after: [],
          requirements: [],
          estimatedDurationSeconds: 60,
          timers: [{ id: "pack-timer", durationSeconds: 60, autoStart: false }],
          domainData: {},
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("preserves legacy unstructured timer payloads", () => {
    const schema = executionPlanSchema(z.object({}));
    const legacyTimer = { name: "old-timer", seconds: 30 };
    const result = schema.safeParse({
      id: "legacy",
      version: 1,
      goal,
      steps: [
        {
          id: "wait",
          executor: { type: "human" },
          after: [],
          requirements: [],
          estimatedDurationSeconds: 30,
          timers: [legacyTimer],
          domainData: {},
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.steps[0]?.timers).toEqual([legacyTimer]);
  });

  it("rejects empty label and duplicate timer ids across the plan", () => {
    const schema = executionPlanSchema(z.object({}));
    expect(
      schema.safeParse({
        id: "morning",
        version: 1,
        goal,
        steps: [
          {
            id: "a",
            label: "   ",
            executor: { type: "human" },
            after: [],
            requirements: [],
            estimatedDurationSeconds: 1,
            timers: [],
            domainData: {},
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        id: "morning",
        version: 1,
        goal,
        steps: [
          {
            id: "a",
            executor: { type: "human" },
            after: [],
            requirements: [],
            estimatedDurationSeconds: 1,
            timers: [{ id: "t1", durationSeconds: 1 }],
            domainData: {},
          },
          {
            id: "b",
            executor: { type: "human" },
            after: [],
            requirements: [],
            estimatedDurationSeconds: 1,
            timers: [{ id: "t1", durationSeconds: 2 }],
            domainData: {},
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("parses timer definitions", () => {
    expect(
      timerDefinitionSchema.safeParse({
        id: "charge-wait",
        durationSeconds: 300,
        label: "Charge",
        autoStart: true,
      }).success,
    ).toBe(true);
  });
});
