import { freeTextValueSchema } from "@pear-agent/core";
import { z } from "zod";

export const OUTING_DOMAIN_ID = "outing";
export const OUTING_DOMAIN_VERSION = 1;

export const belongingInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  chargePercent: z.number().min(0).max(100).optional(),
});

export const belongingSchema = belongingInputSchema.extend({
  chargePercent: z.number().min(0).max(100).nullable(),
});

export const taskInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  estimatedDurationSeconds: z.number().positive().optional(),
  notes: z.string().max(500).optional(),
});

export const taskSchema = taskInputSchema.extend({
  estimatedDurationSeconds: z.number().positive().nullable(),
  notes: z.string().max(500).nullable(),
});

export const placeLabelSchema = z.string().trim().min(1).max(160);

export const outingWorldStateFactsSchema = z.object({
  departureAt: z.iso.datetime(),
  packedBelongingIds: z.array(z.string().min(1)),
  chargeByBelongingId: z.record(z.string(), z.number().min(0).max(100).nullable()),
});

export const outingInputSchema = z
  .object({
    departureAt: z.union([z.iso.datetime(), freeTextValueSchema]),
    belongings: z.union([z.array(belongingInputSchema), freeTextValueSchema]).optional(),
    tasks: z.union([z.array(taskInputSchema), freeTextValueSchema]).optional(),
    originLabel: z.union([placeLabelSchema, freeTextValueSchema]).optional(),
    destinationLabel: z.union([placeLabelSchema, freeTextValueSchema]).optional(),
  })
  .superRefine((value, context) => {
    const hasBelongings =
      value.belongings !== undefined &&
      (Array.isArray(value.belongings)
        ? value.belongings.length > 0
        : typeof value.belongings === "object" && value.belongings !== null);
    const hasTasks =
      value.tasks !== undefined &&
      (Array.isArray(value.tasks)
        ? value.tasks.length > 0
        : typeof value.tasks === "object" && value.tasks !== null);
    if (!hasBelongings && !hasTasks) {
      context.addIssue({
        code: "custom",
        message: "At least one belonging or task is required",
        path: ["belongings"],
      });
    }
  });

export const outingNormalizedInputSchema = z
  .object({
    departureAt: z.iso.datetime(),
    belongings: z.array(belongingSchema),
    tasks: z.array(taskSchema).default([]),
    originLabel: placeLabelSchema.nullable().default(null),
    destinationLabel: placeLabelSchema.nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.belongings.length === 0 && value.tasks.length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one belonging or task is required",
        path: ["belongings"],
      });
    }
  });

export const outingStepDataSchema = z.object({
  kind: z.enum(["pack", "charge", "task"]).optional(),
  belongingIds: z.array(z.string().min(1)),
  taskId: z.string().min(1).optional(),
});

export const outingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delay"), minutes: z.number().positive() }),
]);

export type OutingInput = z.infer<typeof outingInputSchema>;
export type OutingNormalizedInput = z.infer<typeof outingNormalizedInputSchema>;
export type OutingStepData = z.infer<typeof outingStepDataSchema>;
export type OutingBelongingInput = z.infer<typeof belongingInputSchema>;
export type OutingTaskInput = z.infer<typeof taskInputSchema>;
export type OutingTask = z.infer<typeof taskSchema>;
