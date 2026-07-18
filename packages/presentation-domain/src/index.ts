import { defineAiDomain, type ExecutionPlan } from "@pear-agent/core";
import { z } from "zod";

export const presentationCompileInputSchema = z
  .object({
    totalSeconds: z.number().int().positive().max(86_400),
    bufferSeconds: z.number().int().nonnegative().default(0),
    audience: z.string().max(2_000).optional(),
  })
  .refine(({ bufferSeconds, totalSeconds }) => bufferSeconds < totalSeconds, {
    message: "bufferSeconds must be less than totalSeconds",
    path: ["bufferSeconds"],
  });

export const presentationNormalizedInputSchema = z
  .object({
    totalSeconds: z.number().int().positive(),
    bufferSeconds: z.number().int().nonnegative(),
    slides: z
      .array(
        z.object({
          page: z.number().int().positive(),
          title: z.string().min(1),
          role: z.string().min(1),
          keyPoints: z.array(z.string()).min(1),
          sourceId: z.string().min(1),
        }),
      )
      .min(1),
  })
  .refine(({ bufferSeconds, totalSeconds }) => bufferSeconds < totalSeconds, {
    message: "bufferSeconds must be less than totalSeconds",
    path: ["bufferSeconds"],
  });

export const presentationStepDataSchema = z.object({
  kind: z.literal("slide"),
  page: z.number().int().positive(),
  role: z.string().min(1),
  keyPoints: z.array(z.string()).min(1),
  transition: z.string().min(1),
});

/** Domain facts only — Core wraps these into WorldState.facts. */
const presentationWorldStateSchema = z.object({
  currentPage: z.number().int().positive().optional(),
  notes: z.array(z.string()).default([]),
});
const presentationEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("slide_changed"), page: z.number().int().positive() }),
  z.object({
    type: z.literal("speech_turn"),
    elapsedSeconds: z.number().nonnegative(),
    words: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("time_threshold"), remainingSeconds: z.number().int().nonnegative() }),
]);

export const presentationDomain = defineAiDomain({
  id: "presentation",
  version: 1,
  schemas: {
    compileInput: presentationCompileInputSchema,
    normalizedInput: presentationNormalizedInputSchema,
    stepData: presentationStepDataSchema,
    worldState: presentationWorldStateSchema,
    events: presentationEventSchema,
  },
  interpretation: {
    instructions:
      "Read the supplied PDF slide by slide. Identify each slide's narrative role and essential speaking points without inventing content.",
  },
  planning: {
    instructions:
      "Create exactly one ordered step per PDF page. Allocate more time to important or information-dense slides while keeping the total allocation within totalSeconds minus bufferSeconds. Include a transition for every slide.",
    objectives: [
      "Fit the hard presentation duration",
      "Preserve narrative coherence",
      "Protect time for the most important slides",
    ],
    validatePlan(plan, input) {
      const issues: string[] = [];
      const budget = input.totalSeconds - input.bufferSeconds;
      const allocated = plan.steps.reduce(
        (sum, step) => sum + (step.estimatedDurationSeconds ?? 0),
        0,
      );
      if (plan.steps.length !== input.slides.length)
        issues.push("Plan must contain one step per slide");
      if (allocated > budget)
        issues.push(`Allocated ${allocated}s exceeds ${budget}s speaking budget`);
      const pages = plan.steps.map((step) => step.domainData.page);
      if (pages.some((page, index) => page !== input.slides[index]?.page))
        issues.push("Slide steps must remain in PDF page order");
      for (const step of plan.steps) {
        if (!step.sourceRefs?.length) issues.push(`Step ${step.id} has no slide provenance`);
      }
      return { valid: issues.length === 0, issues };
    },
  },
  replanning: {
    instructions:
      "Reallocate only remaining slide time from measured overrun or underrun. Never reorder PDF pages and keep a short closing buffer.",
    defaultMode: "confirm",
    reconcileWorldState(_plan: ExecutionPlan, worldState) {
      return worldState;
    },
  },
  realtime: {
    instructions:
      "Coach pace using elapsed time, current slide, speech turns, and configured thresholds. Do not critique content or change the narrative during delivery.",
    defaultLocale: "ja-JP",
  },
  capabilities: [],
  completionPolicy: "automatic",
});
