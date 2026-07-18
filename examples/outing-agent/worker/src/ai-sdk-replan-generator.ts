import {
  executionStepSchema,
  planPatchOperationSchema,
  replanAssessmentSchema,
  type PlanPatch,
} from "@pear-agent/core";
import type {
  ReplanAssessInput,
  ReplanGeneratePatchInput,
  ReplanGenerator,
} from "@pear-agent/cloudflare";
import {
  assessOutingDelayReplan,
  buildOutingDelayPatch,
  outingStepDataSchema,
} from "@pear-agent/outing-domain-example";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

/** Prefer Domain-typed steps so structured output matches outing invariants. */
function patchProposalSchema() {
  const stepSchema = executionStepSchema(outingStepDataSchema);
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

function asOutingEvents(input: ReplanAssessInput | ReplanGeneratePatchInput) {
  return input.recentEvents.map((event) => ({
    id: event.id,
    type: event.type,
    ...("domainType" in event && typeof event.domainType === "string"
      ? { domainType: event.domainType }
      : {}),
    ...("payload" in event ? { payload: event.payload } : {}),
  }));
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
  const proposalSchema = patchProposalSchema();
  return {
    async assess(input: ReplanAssessInput) {
      // Deterministic delay policy first — matches Domain sample and avoids AI flakiness.
      const delayAssessment = assessOutingDelayReplan({
        plan: input.plan,
        recentEvents: asOutingEvents(input),
      });
      if (delayAssessment.needsReplan) return delayAssessment;

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
      // Prefer the Domain delay patch when assessment is the delay policy.
      const delayAssessment = assessOutingDelayReplan({
        plan: input.plan,
        recentEvents: asOutingEvents(input),
      });
      if (
        delayAssessment.needsReplan &&
        delayAssessment.causeEventIds.join("\0") === input.assessment.causeEventIds.join("\0") &&
        delayAssessment.directlyAffectedStepIds.join("\0") ===
          input.assessment.directlyAffectedStepIds.join("\0")
      ) {
        return buildOutingDelayPatch({
          plan: input.plan,
          assessment: input.assessment,
          affectedStepIds: input.affectedStepIds,
          recentEvents: asOutingEvents(input),
        });
      }

      let output: unknown;
      try {
        output = await generate({
          model: options.model,
          schema: proposalSchema,
          system: [
            "Generate the smallest valid partial Plan Patch operations.",
            "Only change steps in affectedStepIds; preserve unrelated and completed work.",
            "For update_step, copy the existing step and change only required fields.",
            "domainData.kind must be one of pack | charge | task.",
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
        });
      } catch (caught) {
        const detail = caught instanceof Error ? caught.message : String(caught);
        throw new Error(`AI replan patch generation failed: ${detail.slice(0, 500)}`);
      }

      let parsed: z.infer<ReturnType<typeof patchProposalSchema>>;
      try {
        parsed = proposalSchema.parse(output);
      } catch (caught) {
        // Fall back to loose core schema so Runtime validation can still reject cleanly.
        try {
          const loose = z
            .object({
              operations: z.array(planPatchOperationSchema).min(1).max(1_000),
              summary: z.string().min(1).max(2_000),
            })
            .strict()
            .parse(output);
          parsed = loose as typeof parsed;
        } catch {
          const detail = caught instanceof Error ? caught.message : String(caught);
          throw new Error(`AI replan patch failed schema validation: ${detail.slice(0, 500)}`);
        }
      }

      return {
        id: "runtime-assigned",
        basePlanId: input.plan.id,
        basePlanVersion: input.plan.version,
        baseLastEventId: operationalLastEventId(input),
        causeEventIds: input.assessment.causeEventIds,
        affectedStepIds: input.affectedStepIds,
        operations: parsed.operations,
        summary: parsed.summary,
      };
    },
  };
}
