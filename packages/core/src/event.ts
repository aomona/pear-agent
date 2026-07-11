import { z } from "zod";

import { jsonValueSchema } from "./world-state.js";

const runtimeEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  actorId: z.string().min(1),
  origin: z.string().min(1),
  occurredAt: z.date(),
});

function coreEventSchema<TType extends string>(type: TType) {
  return runtimeEventEnvelopeSchema.extend({ type: z.literal(type), payload: jsonValueSchema });
}

const sessionStartedEventSchema = coreEventSchema("session_started");
const sessionPausedEventSchema = coreEventSchema("session_paused");
const stepStartedEventSchema = coreEventSchema("step_started");
const stepCompletedEventSchema = coreEventSchema("step_completed");
const stepFailedEventSchema = coreEventSchema("step_failed");
const timerStartedEventSchema = coreEventSchema("timer_started");
const timerPausedEventSchema = coreEventSchema("timer_paused");
const timerCompletedEventSchema = coreEventSchema("timer_completed");
const worldStateUpdatedEventSchema = coreEventSchema("world_state_updated");
const goalEvaluatedEventSchema = coreEventSchema("goal_evaluated");

export const coreRuntimeEventSchema = z.discriminatedUnion(
  "type",
  [
    sessionStartedEventSchema,
    sessionPausedEventSchema,
    stepStartedEventSchema,
    stepCompletedEventSchema,
    stepFailedEventSchema,
    timerStartedEventSchema,
    timerPausedEventSchema,
    timerCompletedEventSchema,
    worldStateUpdatedEventSchema,
    goalEvaluatedEventSchema,
  ],
);

export type CoreRuntimeEvent = z.infer<typeof coreRuntimeEventSchema>;

export const domainRuntimeEventSchema = runtimeEventEnvelopeSchema.extend({
  type: z.literal("domain_event"),
  domainType: z.string().min(1),
  payload: jsonValueSchema,
});

export type DomainRuntimeEvent = z.infer<typeof domainRuntimeEventSchema>;

export const runtimeEventSchema = z.discriminatedUnion("type", [
  sessionStartedEventSchema,
  sessionPausedEventSchema,
  stepStartedEventSchema,
  stepCompletedEventSchema,
  stepFailedEventSchema,
  timerStartedEventSchema,
  timerPausedEventSchema,
  timerCompletedEventSchema,
  worldStateUpdatedEventSchema,
  goalEvaluatedEventSchema,
  domainRuntimeEventSchema,
]);

export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
