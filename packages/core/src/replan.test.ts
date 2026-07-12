import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ExecutionPlan } from "./plan.js";
import {
  analyzeAffectedSubgraph,
  applyPlanPatch,
  normalizePlanPatchSteps,
  PlanPatchValidationError,
  resolvePlanPatchMode,
  type PlanPatch,
} from "./replan.js";
import { createWorldState } from "./world-state.js";

const plan: ExecutionPlan = {
  id: "outing-plan",
  version: 1,
  goal: {
    id: "leave",
    description: "Leave prepared",
    successCriteria: [
      { id: "ready", description: "Ready", evaluator: { type: "human_confirmation" } },
    ],
    completionPolicy: "automatic",
  },
  steps: [
    {
      id: "keys",
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 10,
      timers: [],
      domainData: {},
    },
    {
      id: "charge",
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 300,
      timers: [],
      domainData: {},
    },
    {
      id: "leave-home",
      executor: { type: "human" },
      after: ["keys", "charge"],
      requirements: [],
      estimatedDurationSeconds: 5,
      timers: [],
      domainData: {},
    },
  ],
};

const worldState = createWorldState({ updatedAt: new Date("2026-07-11T00:00:00Z") });
const stepStates = {
  keys: { status: "completed" as const },
  charge: { status: "ready" as const },
  "leave-home": { status: "blocked" as const },
};

function patch(operations: PlanPatch["operations"]): PlanPatch {
  return {
    id: "patch-1",
    basePlanId: plan.id,
    basePlanVersion: plan.version,
    baseLastEventId: "delay-event",
    causeEventIds: ["delay-event"],
    affectedStepIds: ["charge", "leave-home"],
    operations,
    summary: "Extend charging after a delay",
  };
}

describe("partial replanning", () => {
  it("expands directly affected steps to the downstream subgraph", () => {
    expect(analyzeAffectedSubgraph(plan, ["charge"])).toEqual({
      rootStepIds: ["charge"],
      stepIds: ["charge", "leave-home"],
    });
  });

  it("updates only an affected ready step and preserves unaffected completed work", () => {
    const result = applyPlanPatch({
      plan,
      stepStates,
      worldState,
      appliedEventIds: ["delay-event"],
      patch: patch([
        {
          type: "update_step",
          stepId: "charge",
          step: { ...plan.steps[1]!, estimatedDurationSeconds: 600 },
        },
      ]),
    });

    expect(result.plan.version).toBe(2);
    expect(result.plan.steps.find(({ id }) => id === "charge")?.estimatedDurationSeconds).toBe(600);
    expect(result.plan.steps.find(({ id }) => id === "keys")).toEqual(plan.steps[0]);
    expect(result.diff).toEqual({
      addedStepIds: [],
      updatedStepIds: ["charge"],
      removedStepIds: [],
    });
  });

  it("normalizes only touched Domain data and keeps unaffected data unchanged", () => {
    const generatedPatch = patch([
      {
        type: "update_step",
        stepId: "charge",
        step: { ...plan.steps[1]!, domainData: {} },
      },
    ]);
    const result = applyPlanPatch({
      plan,
      stepStates,
      worldState,
      appliedEventIds: ["delay-event"],
      patch: generatedPatch,
      stepDataSchema: z.object({ label: z.string().default("normalized") }),
      reconcileWorldState: (_candidate, current) => ({
        ...current,
        resources: [{ id: "plan-utilization", state: { recalculated: true } }],
      }),
    });
    const normalizedPatch = normalizePlanPatchSteps(generatedPatch, result.plan);

    expect(result.plan.steps.find(({ id }) => id === "keys")?.domainData).toEqual({});
    expect(result.plan.steps.find(({ id }) => id === "charge")?.domainData).toEqual({
      label: "normalized",
    });
    expect(normalizedPatch.operations[0]).toMatchObject({
      type: "update_step",
      step: { domainData: { label: "normalized" } },
    });
    expect(result.worldState.resources).toEqual([
      { id: "plan-utilization", state: { recalculated: true } },
    ]);
  });

  it("does not reparse untouched output from a non-idempotent Domain transform", () => {
    const transformedPlan: ExecutionPlan = {
      ...plan,
      steps: plan.steps.map((step) => ({
        ...step,
        domainData: { normalized: step.id },
      })),
    };
    const transformedPatch: PlanPatch = {
      ...patch([]),
      operations: [
        {
          type: "update_step",
          stepId: "charge",
          step: {
            ...transformedPlan.steps[1]!,
            domainData: { raw: "new-charge" },
          },
        },
      ],
    };
    const result = applyPlanPatch({
      plan: transformedPlan,
      stepStates,
      worldState,
      appliedEventIds: ["delay-event"],
      patch: transformedPatch,
      stepDataSchema: z.object({ raw: z.string() }).transform(({ raw }) => ({ normalized: raw })),
    });

    expect(result.plan.steps.find(({ id }) => id === "keys")?.domainData).toEqual({
      normalized: "keys",
    });
    expect(result.plan.steps.find(({ id }) => id === "charge")?.domainData).toEqual({
      normalized: "new-charge",
    });
  });

  it("never weakens Domain mode and escalates high-risk capabilities", () => {
    const capabilityPatch = patch([
      {
        type: "update_step",
        stepId: "charge",
        step: {
          ...plan.steps[1]!,
          executor: { type: "agent", capabilityId: "charge-device" },
        },
      },
    ]);
    const policies = [
      {
        id: "charge-device",
        executionMode: "automatic" as const,
        riskLevel: "high" as const,
      },
    ];

    expect(
      resolvePlanPatchMode({
        defaultMode: "confirm",
        requestedMode: "automatic",
        patch: capabilityPatch,
        capabilityPolicies: policies,
      }),
    ).toBe("confirm");
    expect(
      resolvePlanPatchMode({
        defaultMode: "automatic",
        patch: capabilityPatch,
        capabilityPolicies: policies,
      }),
    ).toBe("confirm");
    expect(
      resolvePlanPatchMode({
        defaultMode: "automatic",
        requestedMode: "suggest",
        patch: capabilityPatch,
        capabilityPolicies: policies,
      }),
    ).toBe("suggest");
  });

  it("rejects completed step changes and operations outside the affected subgraph", () => {
    expect(() =>
      applyPlanPatch({
        plan,
        stepStates,
        worldState,
        appliedEventIds: ["delay-event"],
        patch: {
          ...patch([]),
          affectedStepIds: ["keys"],
          operations: [{ type: "remove_step", stepId: "keys" }],
        },
      }),
    ).toThrow("Cannot change completed step: keys");

    expect(() =>
      applyPlanPatch({
        plan,
        stepStates,
        worldState,
        appliedEventIds: ["delay-event"],
        patch: patch([{ type: "remove_step", stepId: "keys" }]),
      }),
    ).toThrow("Patch operation touches unaffected step: keys");

    expect(() =>
      applyPlanPatch({
        plan,
        stepStates: { ...stepStates, keys: { status: "skipped" } },
        worldState,
        appliedEventIds: ["delay-event"],
        patch: {
          ...patch([]),
          affectedStepIds: ["keys"],
          operations: [{ type: "remove_step", stepId: "keys" }],
        },
      }),
    ).toThrow("Cannot change skipped step: keys");
  });

  it("requires pause and human confirmation before changing an active step", () => {
    const activeStates = { ...stepStates, charge: { status: "active" as const } };
    const input = {
      plan,
      stepStates: activeStates,
      worldState,
      appliedEventIds: ["delay-event"],
      patch: patch([{ type: "remove_step", stepId: "charge" }]),
    };
    expect(() => applyPlanPatch(input)).toThrow(
      "Active steps must be paused before a confirmed patch can be applied",
    );
    expect(() =>
      applyPlanPatch({
        ...input,
        allowActiveStepProposal: true,
      }),
    ).toThrow("missing_dependency");

    expect(() =>
      applyPlanPatch({
        ...input,
        stepStates: { ...stepStates, charge: { status: "paused" } },
        patch: patch([
          {
            type: "update_step",
            stepId: "charge",
            step: { ...plan.steps[1]!, estimatedDurationSeconds: 600 },
          },
        ]),
      }),
    ).toThrow("Paused or failed step changes require human confirmation");
  });

  it("rejects invalid DAGs, Domain data, capabilities, WorldState policy, and stale bases", () => {
    expect(() =>
      applyPlanPatch({
        plan,
        stepStates,
        worldState,
        appliedEventIds: ["delay-event"],
        patch: patch([
          {
            type: "update_step",
            stepId: "charge",
            step: { ...plan.steps[1]!, after: ["leave-home"] },
          },
        ]),
      }),
    ).toThrow("Invalid plan graph: cycle");

    expect(() =>
      applyPlanPatch({
        plan,
        stepStates,
        worldState,
        appliedEventIds: ["delay-event"],
        patch: patch([
          {
            type: "update_step",
            stepId: "charge",
            step: { ...plan.steps[1]!, domainData: { unexpected: true } },
          },
        ]),
        stepDataSchema: z.object({ valid: z.boolean().optional() }).strict(),
      }),
    ).toThrow();

    const agentStep = {
      ...plan.steps[1]!,
      executor: { type: "agent" as const, capabilityId: "charge-device" },
    };
    expect(() =>
      applyPlanPatch({
        plan,
        stepStates,
        worldState,
        appliedEventIds: ["delay-event"],
        patch: patch([{ type: "update_step", stepId: "charge", step: agentStep }]),
        capabilityIds: [],
      }),
    ).toThrow("Unknown capability charge-device");

    expect(() =>
      applyPlanPatch({
        plan,
        stepStates,
        worldState,
        appliedEventIds: ["delay-event"],
        patch: patch([{ type: "update_step", stepId: "charge", step: plan.steps[1]! }]),
        reconcileWorldState: () => {
          throw new PlanPatchValidationError("WorldState policy rejected patch");
        },
      }),
    ).toThrow("WorldState policy rejected patch");

    expect(() =>
      applyPlanPatch({
        plan,
        stepStates,
        worldState,
        appliedEventIds: ["delay-event"],
        patch: {
          ...patch([{ type: "update_step", stepId: "charge", step: plan.steps[1]! }]),
          basePlanVersion: 99,
        },
      }),
    ).toThrow("Patch base plan does not match");

    expect(() =>
      applyPlanPatch({
        plan,
        stepStates,
        worldState,
        appliedEventIds: ["delay-event", "newer-event"],
        patch: patch([{ type: "update_step", stepId: "charge", step: plan.steps[1]! }]),
      }),
    ).toThrow("Patch event cursor is stale");
  });
});
