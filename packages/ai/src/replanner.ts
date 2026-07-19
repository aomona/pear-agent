import {
  executionStepSchema,
  planPatchSchema,
  type PlanPatch,
  type PlanPatchOperation,
  type ReplanGenerator,
  type ReplanGeneratorInput,
} from "@pear-agent/core";
import type { LanguageModel } from "ai";
import { z } from "zod";

import { generateStructured, type StructuredGenerator } from "./generate.js";
import { rewriteAffectedStepIds, rewritePatchStepIdentity } from "./identity.js";

export type CreateAiReplanGeneratorOptions = {
  model: LanguageModel;
  stepDataSchema: z.ZodType;
  promptVersion?: string;
  generate?: StructuredGenerator;
  createId?: () => string;
};

function operationSchemas(stepDataSchema: z.ZodType) {
  const stepSchema = executionStepSchema(stepDataSchema);
  return z
    .object({
      operations: z
        .array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("add_step"), step: stepSchema }).strict(),
            z
              .object({
                type: z.literal("update_step"),
                stepId: z.string().min(1),
                step: stepSchema,
              })
              .strict(),
            z.object({ type: z.literal("remove_step"), stepId: z.string().min(1) }).strict(),
          ]),
        )
        .min(1)
        .max(1_000),
      summary: z.string().min(1).max(2_000),
    })
    .strict();
}

/** Generate a bounded partial patch; Runtime overwrites identity and causal anchors. */
export function createAiReplanGenerator(options: CreateAiReplanGeneratorOptions): ReplanGenerator {
  const generate = options.generate ?? generateStructured;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const modelPatchSchema = operationSchemas(options.stepDataSchema);
  return {
    async generatePatch(input: ReplanGeneratorInput): Promise<PlanPatch> {
      const result = await generate({
        model: options.model,
        schema: modelPatchSchema,
        stage: "replan",
        promptVersion: options.promptVersion ?? "pear-replan-v1",
        schemaVersion: input.domainId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
        system: [
          "Return the smallest valid PlanPatch for the affected subgraph.",
          "Preserve completed and unaffected work. Never return a full replacement plan.",
          "Use only supplied affectedStepIds and cause refs. Runtime assigns patch identity, causal anchors, and new step ids.",
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
      const rewritten = rewritePatchStepIdentity(
        candidate.operations as PlanPatchOperation[],
        input.plan,
        createId,
        { causeRefs: input.causeRefs },
      );
      return planPatchSchema.parse({
        ...candidate,
        operations: rewritten.operations,
        id: `patch-${createId()}`,
        basePlanId: input.plan.id,
        basePlanVersion: input.plan.version,
        baseLastEventId: input.baseLastEventId,
        causeEventIds,
        causeRefs: input.causeRefs,
        affectedStepIds: rewriteAffectedStepIds(
          input.affectedStepIds,
          rewritten.stepIds,
          rewritten.addedStepIds,
        ),
      });
    },
  };
}
