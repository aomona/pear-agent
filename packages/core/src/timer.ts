import { z } from "zod";

import { dateSchema } from "./date.js";

export const executionTimerStatusSchema = z.enum(["running", "paused", "completed", "cancelled"]);

export type ExecutionTimerStatus = z.infer<typeof executionTimerStatusSchema>;

export const executionTimerSchema = z.object({
  id: z.string().min(1),
  status: executionTimerStatusSchema,
  durationSeconds: z.number().nonnegative(),
  remainingSeconds: z.number().nonnegative(),
  startedAt: dateSchema,
  endsAt: dateSchema.optional(),
});

export const runningExecutionTimerSchema = executionTimerSchema.extend({
  status: z.literal("running"),
  endsAt: dateSchema,
});

export type ExecutionTimer = z.infer<typeof executionTimerSchema>;
