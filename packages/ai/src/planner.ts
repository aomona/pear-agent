import {
  executionPlanSchema,
  type ExecutionGoal,
  type ExecutionPlan,
  type SourceReference,
} from "@pear-agent/core";
import type { LanguageModel } from "ai";
import type { z } from "zod";

import { generateStructured, type StructuredGenerator } from "./generate.js";
import { rewriteCreatedPlanIdentity } from "./identity.js";

export type AiPlanGeneratorInput = {
  domainId: string;
  domainVersion: number;
  goal: ExecutionGoal;
  normalizedInput: unknown;
  sourceRefs: readonly SourceReference[];
  instructions: string;
  objectives: readonly string[];
  context?: unknown;
  signal?: AbortSignal;
  maxAttempts?: number;
  maxOutputTokens?: number;
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
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
        system: [
          "Create a coherent executable DAG plan from normalized domain input.",
          "Use temporary unique ids and valid after dependencies; Runtime replaces persistent ids.",
          "Every step must cite supplied source ids in sourceRefs. Do not invent source ids.",
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
      const identified = rewriteCreatedPlanIdentity(result.output, input.sourceRefs, createId);
      return {
        plan: schema.parse({ ...identified, goal: input.goal }),
        generation: {
          ...result.metadata,
          validation: { ok: true, issues: [] },
        },
      };
    },
  };
}
