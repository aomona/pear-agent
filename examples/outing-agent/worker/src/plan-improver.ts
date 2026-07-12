import {
  executionPlanSchema,
  type ExecutionPlan,
  type ExecutionStep,
  type PlanImprover,
} from "@pear-agent/core";
import { z } from "zod";

import { generateGeminiJson, GeminiServiceError } from "./gemini-json.js";

const improveResponseSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Must match an existing step id" },
          label: { type: "string" },
          summary: { type: "string" },
          instructions: { type: "string" },
          estimatedDurationSeconds: { type: "number", minimum: 0 },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

const improveParsedSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  steps: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).max(160).optional(),
      summary: z.string().min(1).max(280).optional(),
      instructions: z.string().min(1).max(2_000).optional(),
      estimatedDurationSeconds: z.number().nonnegative().optional(),
      notes: z.array(z.string().min(1).max(200)).max(20).optional(),
    }),
  ),
});

export type CreateGeminiPlanImproverOptions = {
  getApiKey: () => string | undefined;
  model?: string;
};

/**
 * Merge Gemini step edits into the base plan. Unknown step ids are ignored.
 * Does not add/remove steps (keeps DAG structure stable).
 */
export function applyPlanImproveEdits(
  base: ExecutionPlan,
  edits: z.infer<typeof improveParsedSchema>,
): ExecutionPlan {
  const byId = new Map(edits.steps.map((step) => [step.id, step]));
  const steps: ExecutionStep[] = base.steps.map((step) => {
    const edit = byId.get(step.id);
    if (!edit) return step;
    const next: ExecutionStep = { ...step };
    if (edit.label !== undefined) next.label = edit.label;
    if (edit.summary !== undefined) next.summary = edit.summary;
    if (edit.instructions !== undefined) next.instructions = edit.instructions;
    if (edit.estimatedDurationSeconds !== undefined) {
      next.estimatedDurationSeconds = edit.estimatedDurationSeconds;
    }
    if (edit.notes !== undefined) next.notes = edit.notes;
    // Keep charge timer duration aligned when charge step duration changes.
    if (
      step.id === "charge" &&
      edit.estimatedDurationSeconds !== undefined &&
      Array.isArray(next.timers)
    ) {
      next.timers = next.timers.map((timer) =>
        timer.id === "charge-wait"
          ? { ...timer, durationSeconds: edit.estimatedDurationSeconds! }
          : timer,
      );
    }
    return next;
  });

  const plan: ExecutionPlan = {
    ...base,
    steps,
    ...(edits.title !== undefined ? { title: edits.title } : {}),
  };
  return executionPlanSchema(z.unknown()).parse(plan);
}

/**
 * Host PlanImprover: natural-language tweak request → structured step edits via Gemini.
 */
export function createGeminiPlanImprover(options: CreateGeminiPlanImproverOptions): PlanImprover {
  return {
    async improve(input) {
      const stepSummary = input.basePlan.steps.map((step) => ({
        id: step.id,
        label: step.label,
        summary: step.summary,
        instructions: step.instructions,
        estimatedDurationSeconds: step.estimatedDurationSeconds,
        notes: step.notes,
        after: step.after,
      }));

      const raw = await generateGeminiJson({
        apiKey: options.getApiKey(),
        ...(options.model !== undefined ? { model: options.model } : {}),
        system:
          "Edit only existing step ids. Minimal concrete changes (duration/label/instructions). JSON only.",
        user: [`Request: ${input.request}`, `Steps: ${JSON.stringify(stepSummary)}`].join("\n"),
        schema: improveResponseSchema as unknown as Record<string, unknown>,
        maxOutputTokens: 768,
      });

      const parsed = improveParsedSchema.safeParse(raw);
      if (!parsed.success) {
        throw new GeminiServiceError(`Plan improve response invalid: ${parsed.error.message}`, 502);
      }

      const plan = applyPlanImproveEdits(input.basePlan, parsed.data);
      return { kind: "full" as const, plan };
    },
  };
}
