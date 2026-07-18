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

function assignRuntimeIdentity(
  candidate: ExecutionPlan,
  sourceRefs: readonly SourceReference[],
  createId: () => string,
): ExecutionPlan {
  const knownSourceIds = new Set(sourceRefs.map((ref) => ref.sourceId));
  const planId = `plan-${createId()}`;
  const stepIds = new Map(candidate.steps.map((step) => [step.id, `step-${createId()}`]));
  const timerIds = new Map<string, string>();

  return {
    ...candidate,
    id: planId,
    version: 1,
    steps: candidate.steps.map((step) => {
      const refs = step.sourceRefs ?? [];
      if (refs.length === 0) {
        throw new Error(`Step ${step.id} must cite at least one source in sourceRefs`);
      }
      for (const ref of refs) {
        if (!knownSourceIds.has(ref.sourceId)) {
          throw new Error(`Step ${step.id} references unknown source ${ref.sourceId}`);
        }
      }
      return {
        ...step,
        id: stepIds.get(step.id)!,
        after: step.after.map((id) => stepIds.get(id) ?? id),
        timers: step.timers.map((timer) => {
          const parsed = z
            .object({
              id: z.string().optional(),
              linkedStepId: z.string().optional(),
            })
            .passthrough()
            .safeParse(timer);
          if (!parsed.success) return timer;
          const nextTimerId =
            typeof parsed.data.id === "string"
              ? (timerIds.get(parsed.data.id) ??
                (() => {
                  const id = `timer-${createId()}`;
                  timerIds.set(parsed.data.id!, id);
                  return id;
                })())
              : undefined;
          return {
            ...parsed.data,
            ...(nextTimerId ? { id: nextTimerId } : {}),
            ...(parsed.data.linkedStepId !== undefined
              ? {
                  linkedStepId: stepIds.get(parsed.data.linkedStepId) ?? parsed.data.linkedStepId,
                }
              : {}),
          };
        }),
        sourceRefs: refs.map((ref) => sourceReferenceSchema.parse(ref)),
      };
    }),
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
      const identified = assignRuntimeIdentity(result.output, input.sourceRefs, createId);
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
