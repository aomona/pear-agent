import { z } from "zod";

import { dateSchema } from "./date.js";
import { criterionEvaluationSchema } from "./goal.js";
import { executionPlanSchema } from "./plan.js";
import { worldStateSchema, jsonValueSchema } from "./world-state.js";

const runtimeEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  actorId: z.string().min(1),
  origin: z.string().min(1),
  occurredAt: dateSchema,
});

const emptyPayloadSchema = z.object({}).strict();
const stepPayloadSchema = z.object({ stepId: z.string().min(1) }).strict();
const timerStartedPayloadSchema = z
  .object({ timerId: z.string().min(1), durationSeconds: z.number().nonnegative().optional() })
  .strict();
const timerPayloadSchema = z.object({ timerId: z.string().min(1) }).strict();
const goalEvaluatedPayloadSchema = criterionEvaluationSchema.omit({ evaluatedAt: true }).strict();
const goalCompletionConfirmedPayloadSchema = z.object({ goalId: z.string().min(1) }).strict();
const worldStateFactsPatchedPayloadSchema = z
  .object({ facts: z.record(z.string(), jsonValueSchema) })
  .strict();
const planUpdatedPayloadSchema = z
  .object({
    plan: executionPlanSchema(z.unknown()),
    patchId: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    confirmedActiveStepIds: z.array(z.string().min(1)).optional(),
    worldState: worldStateSchema.optional(),
  })
  .strict();
const continuationPayloadSchema = z.object({ continuationId: z.string().min(1) }).strict();
const replanProposedPayloadSchema = z
  .object({ patchId: z.string().min(1), mode: z.enum(["automatic", "confirm", "suggest"]) })
  .strict();
const replanFailedPayloadSchema = z
  .object({ patchId: z.string().min(1), reason: z.string().min(1) })
  .strict();

function coreEventSchema<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return runtimeEventEnvelopeSchema.extend({ type: z.literal(type), payload });
}

const sessionStartedEventSchema = coreEventSchema("session_started", emptyPayloadSchema);
const sessionPausedEventSchema = coreEventSchema("session_paused", emptyPayloadSchema);
const sessionCancelledEventSchema = coreEventSchema("session_cancelled", emptyPayloadSchema);
const stepStartedEventSchema = coreEventSchema("step_started", stepPayloadSchema);
const stepCompletedEventSchema = coreEventSchema("step_completed", stepPayloadSchema);
const stepFailedEventSchema = coreEventSchema("step_failed", stepPayloadSchema);
const stepPausedEventSchema = coreEventSchema("step_paused", stepPayloadSchema);
const stepSkippedEventSchema = coreEventSchema("step_skipped", stepPayloadSchema);
const timerStartedEventSchema = coreEventSchema("timer_started", timerStartedPayloadSchema);
const timerPausedEventSchema = coreEventSchema("timer_paused", timerPayloadSchema);
const timerCompletedEventSchema = coreEventSchema("timer_completed", timerPayloadSchema);
const timerCancelledEventSchema = coreEventSchema("timer_cancelled", timerPayloadSchema);
const worldStateUpdatedEventSchema = coreEventSchema("world_state_updated", worldStateSchema);
const worldStateFactsPatchedEventSchema = coreEventSchema(
  "world_state_facts_patched",
  worldStateFactsPatchedPayloadSchema,
);
const planUpdatedEventSchema = coreEventSchema("plan_updated", planUpdatedPayloadSchema);
const goalEvaluatedEventSchema = coreEventSchema("goal_evaluated", goalEvaluatedPayloadSchema);
const goalCompletionConfirmedEventSchema = coreEventSchema(
  "goal_completion_confirmed",
  goalCompletionConfirmedPayloadSchema,
);
const continuationSuspendedEventSchema = coreEventSchema(
  "continuation_suspended",
  continuationPayloadSchema,
);
const continuationWakePendingEventSchema = coreEventSchema(
  "continuation_wake_pending",
  continuationPayloadSchema,
);
const continuationResumingEventSchema = coreEventSchema(
  "continuation_resuming",
  continuationPayloadSchema,
);
const continuationCompletedEventSchema = coreEventSchema(
  "continuation_completed",
  continuationPayloadSchema,
);
const continuationResumeFailedEventSchema = coreEventSchema(
  "continuation_resume_failed",
  continuationPayloadSchema,
);
const continuationExpiredEventSchema = coreEventSchema(
  "continuation_expired",
  continuationPayloadSchema,
);
const replanProposedEventSchema = coreEventSchema("replan_proposed", replanProposedPayloadSchema);
const replanFailedEventSchema = coreEventSchema("replan_failed", replanFailedPayloadSchema);

const coreEventSchemas = [
  sessionStartedEventSchema,
  sessionPausedEventSchema,
  sessionCancelledEventSchema,
  stepStartedEventSchema,
  stepCompletedEventSchema,
  stepFailedEventSchema,
  stepPausedEventSchema,
  stepSkippedEventSchema,
  timerStartedEventSchema,
  timerPausedEventSchema,
  timerCompletedEventSchema,
  timerCancelledEventSchema,
  worldStateUpdatedEventSchema,
  worldStateFactsPatchedEventSchema,
  planUpdatedEventSchema,
  goalEvaluatedEventSchema,
  goalCompletionConfirmedEventSchema,
  continuationSuspendedEventSchema,
  continuationWakePendingEventSchema,
  continuationResumingEventSchema,
  continuationCompletedEventSchema,
  continuationResumeFailedEventSchema,
  continuationExpiredEventSchema,
  replanProposedEventSchema,
  replanFailedEventSchema,
] as const;

export const coreRuntimeEventSchema = z.discriminatedUnion("type", coreEventSchemas);
export type CoreRuntimeEvent = z.infer<typeof coreRuntimeEventSchema>;

export const domainRuntimeEventSchema = runtimeEventEnvelopeSchema.extend({
  type: z.literal("domain_event"),
  domainType: z.string().min(1),
  payload: jsonValueSchema,
});
export type DomainRuntimeEvent = z.infer<typeof domainRuntimeEventSchema>;

export const runtimeEventSchema = z.discriminatedUnion("type", [
  ...coreEventSchemas,
  domainRuntimeEventSchema,
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
