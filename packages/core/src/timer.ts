import { z } from "zod";

export const executionTimerStatusSchema = z.enum(["running", "paused", "completed", "cancelled"]);

export type ExecutionTimerStatus = z.infer<typeof executionTimerStatusSchema>;

export const executionTimerSchema = z.object({
  id: z.string().min(1),
  status: executionTimerStatusSchema,
  durationSeconds: z.number().nonnegative(),
  remainingSeconds: z.number().nonnegative(),
  startedAt: z.date(),
  endsAt: z.date().optional(),
});

/** Timer shape exposed by runtime snapshots: only currently running timers. */
export const runningExecutionTimerSchema = executionTimerSchema.extend({
  status: z.literal("running"),
});

export type ExecutionTimer = z.infer<typeof executionTimerSchema>;
