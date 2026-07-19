import { z } from "zod";

import { dateSchema } from "./date.js";

export const continuationStatusSchema = z.enum([
  "suspended",
  "wake_pending",
  "resuming",
  "completed",
  "expired",
]);
export type ContinuationStatus = z.infer<typeof continuationStatusSchema>;

export const continuationWakeConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("time"), wakeAt: dateSchema }),
  z.object({ type: z.literal("event"), eventType: z.string().min(1) }),
]);
export type ContinuationWakeCondition = z.infer<typeof continuationWakeConditionSchema>;

/** Durable checkpoint used to reconnect a new Voice Session to an Execution Session. */
export const executionContinuationSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  status: continuationStatusSchema,
  wakeCondition: continuationWakeConditionSchema,
  suspendedReason: z.string().min(1),
  resumeDirective: z.string().min(1),
  checkpointPlanVersionId: z.string().min(1),
  checkpointLastEventId: z.string().nullable(),
  providerResumeHandle: z.string().nullable(),
  schedulerId: z.string().nullable(),
  resumingActorId: z.string().min(1).nullable().default(null),
  resumeAttemptId: z.string().min(1).nullable().default(null),
  resumeClaimedAt: dateSchema.nullable().default(null),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});
export type ExecutionContinuation = z.infer<typeof executionContinuationSchema>;

export function checkpointPlanVersionId(planId: string, version: number): string {
  return `${planId}:${version}`;
}
