import type { ReplanAssessInput, ReplanGeneratePatchInput } from "@pear-agent/cloudflare";
import { initialOutingWorldState, outingPlan } from "@pear-agent/outing-domain-example";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import { createAiSdkReplanGenerator } from "../worker/src/ai-sdk-replan-generator.js";

const delayEvent = {
  id: "event-delay",
  sessionId: "session-1",
  idempotencyKey: "delay-1",
  actorId: "actor-1",
  origin: "voice",
  occurredAt: new Date("2026-07-13T00:00:00.000Z"),
  type: "domain_event" as const,
  domainType: "delay",
  payload: { minutes: 15 },
};

const assessInput = {
  sessionId: "session-1",
  domainId: "outing",
  instructions: "Update only affected preparation steps",
  context: { actorId: "actor-1", roles: [], claims: {} },
  normalizedInput: null,
  goal: outingPlan.goal,
  plan: outingPlan,
  worldState: initialOutingWorldState,
  recentEvents: [delayEvent],
} satisfies ReplanAssessInput;

describe("createAiSdkReplanGenerator", () => {
  it("accepts any AI SDK LanguageModel and keeps patch identity fields deterministic", async () => {
    const generated = [
      {
        needsReplan: true,
        causeEventIds: [delayEvent.id],
        directlyAffectedStepIds: ["charge"],
        reason: "The delay affects charging",
      },
      {
        operations: [
          {
            type: "update_step",
            stepId: "charge",
            step: {
              ...outingPlan.steps.find(({ id }) => id === "charge")!,
              estimatedDurationSeconds: 360,
            },
          },
        ],
        summary: "Extend charging",
      },
    ];
    const generator = createAiSdkReplanGenerator({
      model: {} as LanguageModel,
      generateStructured: async () => generated.shift(),
    });

    const assessment = await generator.assess(assessInput);
    const patch = await generator.generatePatch({
      ...assessInput,
      assessment,
      affectedStepIds: ["charge"],
      mode: "automatic",
    } satisfies ReplanGeneratePatchInput);

    expect(patch).toMatchObject({
      basePlanId: outingPlan.id,
      basePlanVersion: outingPlan.version,
      baseLastEventId: delayEvent.id,
      causeEventIds: [delayEvent.id],
      affectedStepIds: ["charge"],
    });
    expect(patch.summary).toMatch(/charging/i);
  });

  it("uses deterministic delay assessment and patch without calling the model", async () => {
    let calls = 0;
    const generator = createAiSdkReplanGenerator({
      model: {} as LanguageModel,
      generateStructured: async () => {
        calls += 1;
        throw new Error("model should not be called for delay replan");
      },
    });

    const assessment = await generator.assess(assessInput);
    expect(assessment).toMatchObject({
      needsReplan: true,
      causeEventIds: [delayEvent.id],
      directlyAffectedStepIds: ["charge"],
    });
    const patch = await generator.generatePatch({
      ...assessInput,
      assessment,
      affectedStepIds: ["charge"],
      mode: "automatic",
    } satisfies ReplanGeneratePatchInput);

    expect(calls).toBe(0);
    expect(patch.operations[0]).toMatchObject({
      type: "update_step",
      stepId: "charge",
    });
    expect(patch.summary).toMatch(/charging/i);
  });
});
