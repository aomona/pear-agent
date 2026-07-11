import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  capabilityDefinitionSchema,
  executionActorSchema,
  executionModeSchema,
  resolveExecutionMode,
  riskLevelSchema,
  stepAssignmentSchema,
  type ExecutionMode,
  type RiskLevel,
} from "./index.js";

describe("execution policy schemas", () => {
  it("rejects an unsupported execution mode", () => {
    expect(executionModeSchema.safeParse("manual").success).toBe(false);
  });

  it("rejects an unsupported risk level", () => {
    expect(riskLevelSchema.safeParse("critical").success).toBe(false);
  });
});

describe("capabilityDefinitionSchema", () => {
  const inputSchema = z.object({ message: z.string() });
  const outputSchema = z.object({ delivered: z.boolean() });
  const schema = capabilityDefinitionSchema(inputSchema, outputSchema);

  it("rejects an invalid capability policy boundary", () => {
    expect(
      schema.safeParse({
        id: "notify",
        description: "Send a notification",
        inputSchema,
        outputSchema,
        executionMode: "manual",
        riskLevel: "critical",
        execute: async () => ({ delivered: true }),
      }).success,
    ).toBe(false);
  });

  it("rejects capability definitions with different schemas", () => {
    expect(
      schema.safeParse({
        id: "notify",
        description: "Send a notification",
        inputSchema: z.string(),
        outputSchema,
        executionMode: "confirm",
        riskLevel: "medium",
        execute: async () => ({ delivered: true }),
      }).success,
    ).toBe(false);
  });
});

describe("resolveExecutionMode", () => {
  it("requires confirmation for an automatic high-risk capability", () => {
    expect(resolveExecutionMode({ configuredMode: "automatic", riskLevel: "high" })).toBe(
      "confirm",
    );
  });

  it.each<[ExecutionMode, RiskLevel, ExecutionMode]>([
    ["automatic", "low", "automatic"],
    ["automatic", "medium", "automatic"],
    ["automatic", "high", "confirm"],
    ["confirm", "low", "confirm"],
    ["confirm", "medium", "confirm"],
    ["confirm", "high", "confirm"],
    ["suggest", "low", "suggest"],
    ["suggest", "medium", "suggest"],
    ["suggest", "high", "suggest"],
  ])("resolves %s mode at %s risk to %s", (configuredMode, riskLevel, expectedMode) => {
    expect(resolveExecutionMode({ configuredMode, riskLevel })).toBe(expectedMode);
  });
});

describe("executionActorSchema", () => {
  it.each(["human", "agent", "system"] as const)("accepts the %s actor kind", (kind) => {
    expect(executionActorSchema.parse({ id: `${kind}-actor`, kind })).toEqual({
      id: `${kind}-actor`,
      kind,
    });
  });
});

describe("stepAssignmentSchema", () => {
  it("rejects an assignment without actors", () => {
    expect(stepAssignmentSchema.safeParse({ stepId: "prepare", actorIds: [] }).success).toBe(false);
  });

  it("accepts an assignment with one or more actors", () => {
    expect(
      stepAssignmentSchema.parse({ stepId: "prepare", actorIds: ["human-1", "agent-1"] }),
    ).toEqual({ stepId: "prepare", actorIds: ["human-1", "agent-1"] });
  });
});
