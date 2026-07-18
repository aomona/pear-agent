import { defineAiDomain, type ExecutionPlan } from "@pear-agent/core";
import { z } from "zod";

export const cookCompileInputSchema = z.object({
  servings: z.number().int().positive().max(100),
  serveAt: z.iso.datetime({ offset: true }),
  equipment: z.array(z.string().trim().min(1)).max(100).default([]),
  notes: z.string().max(10_000).optional(),
});

export const cookNormalizedInputSchema = z.object({
  servings: z.number().int().positive(),
  serveAt: z.iso.datetime({ offset: true }),
  equipment: z.array(z.string()),
  dishes: z
    .array(
      z.object({
        name: z.string().min(1),
        ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
        sourceIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  constraints: z.array(z.string()).default([]),
});

export const cookStepDataSchema = z.object({
  kind: z.enum(["prepare", "cook", "wait", "plate", "serve"]),
  dish: z.string().min(1),
  instruction: z.string().min(1),
  equipment: z.array(z.string()).default([]),
  safetyNote: z.string().optional(),
});

/** Domain facts only — Core wraps these into WorldState.facts. */
const cookWorldStateSchema = z.object({
  activeDish: z.string().optional(),
  notes: z.array(z.string()).default([]),
});

const cookEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("timer_elapsed"), timerId: z.string() }),
  z.object({
    type: z.literal("delay_reported"),
    stepId: z.string(),
    seconds: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("safety_observation"),
    message: z.string(),
    confidence: z.number().min(0).max(1),
  }),
]);

export const cookDomain = defineAiDomain({
  id: "cook",
  version: 1,
  schemas: {
    compileInput: cookCompileInputSchema,
    normalizedInput: cookNormalizedInputSchema,
    stepData: cookStepDataSchema,
    worldState: cookWorldStateSchema,
    events: cookEventSchema,
  },
  interpretation: {
    instructions:
      "Read every recipe source, normalize ingredient quantities for the requested servings, preserve source disagreements, and ask only about ambiguities that materially change safety or timing.",
  },
  planning: {
    instructions:
      "Build one backwards-scheduled cooking DAG so all dishes are served together. Parallelize safe independent work, model unattended waits as timers, respect equipment capacity, and cite recipe source fragments on every step.",
    objectives: [
      "Serve every dish at the requested time",
      "Avoid equipment conflicts",
      "Keep food safety explicit",
    ],
    validatePlan(plan, input) {
      const issues: string[] = [];
      if (plan.steps.length === 0) issues.push("Cooking plan must contain steps");
      const served = new Set(
        plan.steps
          .filter((step) => step.domainData.kind === "serve")
          .map((step) => step.domainData.dish),
      );
      for (const dish of input.dishes) {
        if (!served.has(dish.name)) issues.push(`Missing serve step for ${dish.name}`);
      }
      for (const step of plan.steps) {
        if (!step.sourceRefs?.length) issues.push(`Step ${step.id} has no recipe provenance`);
      }
      return { valid: issues.length === 0, issues };
    },
  },
  replanning: {
    instructions:
      "Preserve completed work, adjust only affected downstream cooking steps, and optimize for the original serve time. Never silently weaken safety requirements.",
    defaultMode: "confirm",
    reconcileWorldState(_plan: ExecutionPlan, worldState) {
      return worldState;
    },
  },
  realtime: {
    instructions:
      "Give concise hands-busy guidance. Complete or advance steps only for explicit user actions or high-confidence observations; ask before ambiguous state changes.",
    defaultLocale: "ja-JP",
  },
  capabilities: [],
  completionPolicy: "automatic",
});
