import { defineAiDomain } from "@pear-agent/core";
import { z } from "zod";

export const starterCompileInputSchema = z.object({
  request: z.string().trim().min(1).max(20_000),
});

export const starterNormalizedInputSchema = z.object({
  title: z.string().trim().min(1),
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        description: z.string().trim().min(1),
        estimatedDurationSeconds: z.number().int().positive(),
      }),
    )
    .min(1),
  constraints: z.array(z.string()).default([]),
});

export type StarterNormalizedInput = z.output<typeof starterNormalizedInputSchema>;

export const starterDomain = defineAiDomain({
  id: "starter",
  version: 1,
  schemas: {
    compileInput: starterCompileInputSchema,
    normalizedInput: starterNormalizedInputSchema,
    stepData: z.object({ task: z.string().min(1) }),
    worldState: z.object({ notes: z.array(z.string()) }),
    events: z.discriminatedUnion("type", [
      z.object({ type: z.literal("constraint_changed"), note: z.string().min(1) }),
    ]),
  },
  interpretation: {
    instructions:
      "Turn all source material and the user's request into a concise task model. Ask only when an ambiguity materially changes execution.",
  },
  planning: {
    instructions:
      "Create a practical executable DAG. Parallelize independent tasks and cite source provenance on every step.",
    objectives: [
      "Make the next action obvious",
      "Respect constraints",
      "Keep the plan easy to revise",
    ],
    validatePlan(plan) {
      const issues = plan.steps.flatMap((step) =>
        step.sourceRefs?.length ? [] : [`Step ${step.id} has no source provenance`],
      );
      return {
        valid: plan.steps.length > 0 && issues.length === 0,
        issues: plan.steps.length > 0 ? issues : ["Plan must contain steps", ...issues],
      };
    },
  },
  replanning: {
    instructions:
      "Preserve completed work and update only the steps affected by new facts or constraints.",
    defaultMode: "confirm",
    reconcileWorldState(_plan, worldState) {
      return worldState;
    },
  },
  realtime: {
    instructions: "Guide the current step concisely and confirm low-confidence state changes.",
    defaultLocale: "ja-JP",
  },
  capabilities: [],
  completionPolicy: "automatic",
});
