import { planPatchSchema, type ReplanGenerator } from "@pear-agent/core";
import type { LanguageModel } from "ai";
import { z } from "zod";

import { generateStructured, type StructuredGenerator } from "./generate.js";

export type CreateAiReplanGeneratorOptions = {
  model: LanguageModel;
  stepDataSchema: z.ZodType;
  promptVersion?: string;
  generate?: StructuredGenerator;
  createId?: () => string;
};

/** Generate a bounded partial patch; Runtime overwrites identity and causal anchors. */
export function createAiReplanGenerator(options: CreateAiReplanGeneratorOptions): ReplanGenerator {
  const generate = options.generate ?? generateStructured;
  const createId = options.createId ?? (() => crypto.randomUUID());
  return {
    async generatePatch(input) {
      const result = await generate({
        model: options.model,
        schema: planPatchSchema,
        stage: "replan",
        promptVersion: options.promptVersion ?? "pear-replan-v1",
        schemaVersion: input.domainId,
        system: [
          "Return the smallest valid PlanPatch for the affected subgraph.",
          "Preserve completed and unaffected work. Never return a full replacement plan.",
          "Use only supplied affectedStepIds and cause refs. Runtime assigns patch identity and causal anchors.",
          input.instructions,
        ].join("\n"),
        prompt: JSON.stringify({
          plan: input.plan,
          normalizedInput: input.normalizedInput,
          assessment: input.assessment,
          affectedStepIds: input.affectedStepIds,
          causeRefs: input.causeRefs,
        }),
      });
      const candidate = result.output;
      const causeEventIds = input.causeRefs.flatMap((cause) =>
        cause.type === "runtime_event" ? [cause.eventId] : [],
      );
      if (causeEventIds.length === 0) {
        throw new Error("Runtime replan requires at least one runtime_event cause reference");
      }
      return planPatchSchema.parse({
        ...candidate,
        id: `patch-${createId()}`,
        basePlanId: input.plan.id,
        basePlanVersion: input.plan.version,
        causeEventIds,
        causeRefs: input.causeRefs,
        affectedStepIds: [...input.affectedStepIds],
      });
    },
  };
}
