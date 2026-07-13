import { planPatchOperationSchema, replanAssessmentSchema, type PlanPatch } from "@pear-agent/core";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

import type {
  ReplanAssessInput,
  ReplanGeneratePatchInput,
  ReplanGenerator,
} from "@pear-agent/cloudflare";

const patchProposalSchema = z
  .object({
    operations: z.array(planPatchOperationSchema).min(1).max(1_000),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

type StructuredGenerationInput = {
  model: LanguageModel;
  schema: z.ZodType;
  system: string;
  prompt: string;
};

type StructuredGenerator = (input: StructuredGenerationInput) => Promise<unknown>;

async function generateStructured(input: StructuredGenerationInput): Promise<unknown> {
  const result = await generateText({
    model: input.model,
    output: Output.object({ schema: input.schema }),
    system: input.system,
    prompt: input.prompt,
    temperature: 0,
    maxOutputTokens: 2_048,
  });
  return result.output;
}

function operationalLastEventId(input: ReplanGeneratePatchInput): string | null {
  return (
    input.recentEvents
      .filter(
        ({ type }) =>
          type !== "replan_proposed" &&
          type !== "replan_failed" &&
          type !== "plan_updated" &&
          !type.startsWith("continuation_"),
      )
      .at(-1)?.id ?? null
  );
}

export type CreateAiSdkReplanGeneratorOptions = {
  model: LanguageModel;
  /** Test seam; production uses AI SDK structured output. */
  generateStructured?: StructuredGenerator;
};

/** Provider-neutral AI SDK ReplanGenerator. Runtime owns identity and validation. */
export function createAiSdkReplanGenerator(
  options: CreateAiSdkReplanGeneratorOptions,
): ReplanGenerator {
  const generate = options.generateStructured ?? generateStructured;
  return {
    async assess(input: ReplanAssessInput) {
      const output = await generate({
        model: options.model,
        schema: replanAssessmentSchema,
        system: [
          "Assess whether the execution plan needs partial replanning.",
          "Use only recent event ids and existing plan step ids.",
          "Return needsReplan=false when no existing step is affected.",
          input.instructions,
        ].join("\n"),
        prompt: JSON.stringify({
          goal: input.goal,
          plan: input.plan,
          worldState: input.worldState,
          recentEvents: input.recentEvents,
          normalizedInput: input.normalizedInput,
        }),
      });
      return replanAssessmentSchema.parse(output);
    },

    async generatePatch(input: ReplanGeneratePatchInput): Promise<PlanPatch> {
      const output = patchProposalSchema.parse(
        await generate({
          model: options.model,
          schema: patchProposalSchema,
          system: [
            "Generate the smallest valid partial Plan Patch operations.",
            "Only change steps in affectedStepIds; preserve unrelated and completed work.",
            "Return operations and a concise summary. Runtime supplies patch identity and base fields.",
            input.instructions,
          ].join("\n"),
          prompt: JSON.stringify({
            plan: input.plan,
            worldState: input.worldState,
            recentEvents: input.recentEvents,
            normalizedInput: input.normalizedInput,
            assessment: input.assessment,
            affectedStepIds: input.affectedStepIds,
            mode: input.mode,
          }),
        }),
      );

      return {
        id: "runtime-assigned",
        basePlanId: input.plan.id,
        basePlanVersion: input.plan.version,
        baseLastEventId: operationalLastEventId(input),
        causeEventIds: input.assessment.causeEventIds,
        affectedStepIds: input.affectedStepIds,
        operations: output.operations,
        summary: output.summary,
      };
    },
  };
}
