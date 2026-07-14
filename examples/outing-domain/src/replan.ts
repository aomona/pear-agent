import {
  PlanPatchValidationError,
  type ExecutionPlan,
  type PlanPatch,
  type ReplanAssessment,
  type WorldState,
} from "@pear-agent/core";

import { OUTING_CHARGE_TIMER_ID, OUTING_DELAY_CHARGE_EXTENSION_SECONDS } from "./plan.js";
import { outingWorldStateFactsSchema } from "./schemas.js";

export type OutingReplanEventLike = {
  id: string;
  type: string;
  domainType?: string;
  payload?: unknown;
};

function isDelayEvent(
  event: OutingReplanEventLike,
): event is OutingReplanEventLike & { domainType: "delay"; payload: { minutes: number } } {
  if (event.type !== "domain_event" || event.domainType !== "delay") return false;
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return false;
  }
  return typeof (event.payload as { minutes?: unknown }).minutes === "number";
}

export function assessOutingDelayReplan(input: {
  plan: ExecutionPlan;
  recentEvents: readonly OutingReplanEventLike[];
}): ReplanAssessment {
  const cause = [...input.recentEvents].reverse().find(isDelayEvent);
  if (!cause) {
    return {
      needsReplan: false,
      causeEventIds: [],
      directlyAffectedStepIds: [],
      reason: "No delay event requires replanning",
    };
  }
  if (!input.plan.steps.some(({ id }) => id === "charge")) {
    return {
      needsReplan: false,
      causeEventIds: [cause.id],
      directlyAffectedStepIds: [],
      reason: "The plan has no charge step affected by the delay",
    };
  }
  return {
    needsReplan: true,
    causeEventIds: [cause.id],
    directlyAffectedStepIds: ["charge"],
    reason: "A delay changes the charging window",
  };
}

const REPLAN_AUDIT_EVENT_TYPES = new Set(["replan_proposed", "replan_failed", "plan_updated"]);

export function buildOutingDelayPatch(input: {
  plan: ExecutionPlan;
  assessment: ReplanAssessment;
  affectedStepIds: readonly string[];
  recentEvents: readonly OutingReplanEventLike[];
  patchId?: string;
}): PlanPatch {
  const charge = input.plan.steps.find(({ id }) => id === "charge");
  if (!charge) throw new Error("Outing plan has no charge step to replan");
  const baseLastEventId =
    input.recentEvents
      .filter(
        ({ type }) => !REPLAN_AUDIT_EVENT_TYPES.has(type) && !type.startsWith("continuation_"),
      )
      .at(-1)?.id ?? null;
  const nextDuration = charge.estimatedDurationSeconds + OUTING_DELAY_CHARGE_EXTENSION_SECONDS;
  const nextTimers = Array.isArray(charge.timers)
    ? charge.timers.map((timer) =>
        typeof timer === "object" &&
        timer !== null &&
        !Array.isArray(timer) &&
        "id" in timer &&
        timer.id === OUTING_CHARGE_TIMER_ID
          ? { ...timer, durationSeconds: nextDuration }
          : timer,
      )
    : charge.timers;
  const patchId =
    input.patchId ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `outing-delay-patch-${crypto.randomUUID()}`
      : `outing-delay-patch-${Math.random().toString(36).slice(2)}`);
  return {
    id: patchId,
    basePlanId: input.plan.id,
    basePlanVersion: input.plan.version,
    baseLastEventId,
    causeEventIds: input.assessment.causeEventIds,
    affectedStepIds: [...input.affectedStepIds],
    operations: [
      {
        type: "update_step",
        stepId: charge.id,
        step: {
          ...charge,
          estimatedDurationSeconds: nextDuration,
          timers: nextTimers,
        },
      },
    ],
    summary: "Extend charging after the delay",
  };
}

export function reconcileOutingWorldState(plan: ExecutionPlan, worldState: WorldState): WorldState {
  outingWorldStateFactsSchema.parse(worldState.facts);
  const availableResources = new Set(worldState.resources.map(({ id }) => id));
  for (const step of plan.steps) {
    const unavailable = step.requirements.find((id) => !availableResources.has(id));
    if (unavailable) {
      throw new PlanPatchValidationError(
        `Unavailable WorldState resource ${unavailable} for step ${step.id}`,
      );
    }
  }
  return {
    ...worldState,
    resources: [
      ...worldState.resources.filter(({ id }) => id !== "plan-utilization"),
      {
        id: "plan-utilization",
        state: {
          requirementsByStep: Object.fromEntries(
            plan.steps.map((step) => [step.id, step.requirements]),
          ),
        },
      },
    ],
  };
}
