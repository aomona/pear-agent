import {
  executionPlanSchema,
  validatePlanGraph,
  type ExecutionPlan,
  type ExecutionStep,
} from "@pear-agent/core";
import { z } from "zod";

import { generateGeminiJson, GeminiServiceError } from "./gemini-json.js";

const orderSchema = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing step id; must not invent new ids" },
          after: {
            type: "array",
            items: { type: "string" },
            description: "Prerequisite step ids that must finish before this step",
          },
          reason: {
            type: "string",
            description: "Short why this order (optional)",
          },
        },
        required: ["id", "after"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

const orderResultSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        after: z.array(z.string().min(1)),
        reason: z.string().optional(),
      }),
    )
    .min(1),
});

/**
 * Apply LLM-suggested `after` dependencies onto an existing plan.
 * Preserves step bodies; only rewires the DAG. Falls back to base on any failure.
 */
export function applyPlanStepOrder(
  base: ExecutionPlan,
  order: z.infer<typeof orderResultSchema>,
): ExecutionPlan {
  const byId = new Map(base.steps.map((s) => [s.id, s]));
  if (order.steps.length !== base.steps.length) {
    throw new Error(
      `Order must include every step once (got ${order.steps.length}, expected ${base.steps.length})`,
    );
  }
  const seen = new Set<string>();
  const rewired: ExecutionStep[] = [];
  for (const entry of order.steps) {
    if (seen.has(entry.id)) throw new Error(`Duplicate step id in order: ${entry.id}`);
    seen.add(entry.id);
    const step = byId.get(entry.id);
    if (!step) throw new Error(`Unknown step id in order: ${entry.id}`);
    for (const dep of entry.after) {
      if (!byId.has(dep)) throw new Error(`Unknown dependency ${dep} for ${entry.id}`);
      if (dep === entry.id) throw new Error(`Self-dependency on ${entry.id}`);
    }
    rewired.push({ ...step, after: [...entry.after] });
  }
  for (const id of byId.keys()) {
    if (!seen.has(id)) throw new Error(`Missing step in order: ${id}`);
  }

  const graph = validatePlanGraph(rewired);
  if (!graph.valid) {
    throw new Error(`Invalid plan graph after order: ${graph.reason}`);
  }

  return executionPlanSchema(z.unknown()).parse({
    ...base,
    steps: rewired,
  });
}

export type RefinePlanOrderInput = {
  apiKey: string | undefined;
  plan: ExecutionPlan;
  /** Extra context (route, belongings, tasks) for better ordering. */
  contextSummary?: string;
};

/**
 * Ask Gemini to set step `after` edges for a sensible prep order.
 * On missing key / LLM / validation failure, returns the base plan unchanged.
 */
export async function refinePlanOrderWithGemini(
  input: RefinePlanOrderInput,
): Promise<{ plan: ExecutionPlan; refined: boolean; reason?: string }> {
  if (!input.apiKey) {
    return { plan: input.plan, refined: false, reason: "no_api_key" };
  }
  if (input.plan.steps.length <= 1) {
    return { plan: input.plan, refined: false, reason: "single_step" };
  }

  const stepSketch = input.plan.steps.map((s) => ({
    id: s.id,
    label: s.label ?? s.id,
    summary: s.summary,
    estimatedDurationSeconds: s.estimatedDurationSeconds,
    currentAfter: s.after,
  }));

  try {
    const raw = await generateGeminiJson({
      apiKey: input.apiKey,
      system: [
        "You order PEAR outing preparation steps as a DAG.",
        "Rules:",
        "- Use ONLY the given step ids; do not add/remove steps.",
        "- Set `after` to prerequisite step ids (empty = can start immediately).",
        "- Prefer parallel work when safe (pack // charge often parallel).",
        "- Charge can run while packing; put short tasks in parallel when independent.",
        "- Avoid cycles. Prefer short critical path when possible.",
        "- JSON only.",
      ].join("\n"),
      user: [
        input.contextSummary ? `Context: ${input.contextSummary}` : "",
        `Steps: ${JSON.stringify(stepSketch)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      schema: orderSchema as unknown as Record<string, unknown>,
      maxOutputTokens: 512,
    });

    const parsed = orderResultSchema.safeParse(raw);
    if (!parsed.success) {
      return { plan: input.plan, refined: false, reason: "parse_failed" };
    }

    const plan = applyPlanStepOrder(input.plan, parsed.data);
    return { plan, refined: true };
  } catch (error) {
    if (error instanceof GeminiServiceError && error.status === 503) {
      return { plan: input.plan, refined: false, reason: "no_api_key" };
    }
    return {
      plan: input.plan,
      refined: false,
      reason: error instanceof Error ? error.message : "refine_failed",
    };
  }
}
