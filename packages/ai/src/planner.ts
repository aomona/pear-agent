import {
  executionPlanSchema,
  sourceReferenceSchema,
  type ExecutionGoal,
  type ExecutionPlan,
  type SourceReference,
} from "@pear-agent/core";
import type { LanguageModel } from "ai";
import { z } from "zod";

import { generateStructured, type StructuredGenerator } from "./generate.js";

export type AiPlanGeneratorInput = {
  domainId: string;
  domainVersion: number;
  goal: ExecutionGoal;
  normalizedInput: unknown;
  sourceRefs: readonly SourceReference[];
  instructions: string;
  objectives: readonly string[];
  context?: unknown;
};

export type AiPlanGenerationResult = {
  plan: ExecutionPlan;
  generation: import("@pear-agent/core").GenerationMetadata;
};

export type AiPlanGenerator = {
  generatePlan(input: AiPlanGeneratorInput): Promise<AiPlanGenerationResult>;
};

export type CreateAiPlanGeneratorOptions = {
  model: LanguageModel;
  stepDataSchema: z.ZodType;
  promptVersion?: string;
  generate?: StructuredGenerator;
  createId?: () => string;
};

function assignRuntimeIdentity(
  candidate: ExecutionPlan,
  sourceRefs: readonly SourceReference[],
  createId: () => string,
): ExecutionPlan {
  const planId = `plan-${createId()}`;
  const stepIds = new Map(candidate.steps.map((step) => [step.id, `step-${createId()}`]));
  return {
    ...candidate,
    id: planId,
    version: 1,
    steps: candidate.steps.map((step) => ({
      ...step,
      id: stepIds.get(step.id)!,
      after: step.after.map((id) => stepIds.get(id) ?? id),
      timers: step.timers.map((timer) => {
        const parsed = z
          .object({ linkedStepId: z.string().optional() })
          .passthrough()
          .safeParse(timer);
        if (!parsed.success || parsed.data.linkedStepId === undefined) return timer;
        return {
          ...parsed.data,
          linkedStepId: stepIds.get(parsed.data.linkedStepId) ?? parsed.data.linkedStepId,
        };
      }),
      sourceRefs:
        step.sourceRefs && step.sourceRefs.length > 0
          ? step.sourceRefs.map((ref) => sourceReferenceSchema.parse(ref))
          : sourceRefs.map((ref) => sourceReferenceSchema.parse(ref)),
    })),
  };
}

export function createAiPlanGenerator(options: CreateAiPlanGeneratorOptions): AiPlanGenerator {
  const schema = executionPlanSchema(options.stepDataSchema);
  const generate = options.generate ?? generateStructured;
  const createId = options.createId ?? (() => crypto.randomUUID());
  return {
    async generatePlan(input) {
      const result = await generate({
        model: options.model,
        schema,
        stage: "plan",
        promptVersion: options.promptVersion ?? "pear-plan-v1",
        schemaVersion: `${input.domainId}@${input.domainVersion}`,
        system: [
          "Create a coherent executable DAG plan from normalized domain input.",
          "Use temporary unique ids and valid after dependencies; Runtime replaces persistent ids.",
          "Every step must cite supplied source ids in sourceRefs.",
          "Respect timers, resources, safety constraints, and the requested goal.",
          input.instructions,
          `Objectives: ${input.objectives.join("; ")}`,
        ].join("\n"),
        prompt: JSON.stringify({
          goal: input.goal,
          normalizedInput: input.normalizedInput,
          availableSourceRefs: input.sourceRefs,
        }),
      });
      const identified = assignRuntimeIdentity(result.output, input.sourceRefs, createId);
      return {
        plan: schema.parse({ ...identified, goal: input.goal }),
        generation: result.metadata,
      };
    },
  };
}
