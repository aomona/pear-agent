import {
  createWorldStateFromDomainFacts,
  defineDomain,
  PlanPatchValidationError,
  type ExecutionGoal,
  type ExecutionPlan,
  type PlanPatch,
  type ReplanAssessment,
  type WorldState,
} from "@pear-agent/core";
import { z } from "zod";

const belongingInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  chargePercent: z.number().min(0).max(100).optional(),
});

const belongingSchema = belongingInputSchema.extend({
  chargePercent: z.number().min(0).max(100).nullable(),
});

/** Domain-specific facts stored in WorldState.facts (not the Core envelope). */
const outingWorldStateFactsSchema = z.object({
  departureAt: z.iso.datetime(),
  packedBelongingIds: z.array(z.string().min(1)),
  chargeByBelongingId: z.record(z.string(), z.number().min(0).max(100).nullable()),
});

const outingInputSchema = z.object({
  departureAt: z.iso.datetime(),
  belongings: z.array(belongingInputSchema),
});

const outingNormalizedInputSchema = z.object({
  departureAt: z.iso.datetime(),
  belongings: z.array(belongingSchema),
});

const outingStepDataSchema = z.object({
  belongingIds: z.array(z.string().min(1)),
});

export type OutingInput = z.infer<typeof outingInputSchema>;
export type OutingNormalizedInput = z.infer<typeof outingNormalizedInputSchema>;
export type OutingStepData = z.infer<typeof outingStepDataSchema>;

export const outingDomain = defineDomain({
  id: "outing",
  version: 1,
  schemas: {
    input: outingInputSchema,
    normalizedInput: outingNormalizedInputSchema,
    stepData: outingStepDataSchema,
    worldState: outingWorldStateFactsSchema,
    events: z.discriminatedUnion("type", [
      z.object({ type: z.literal("delay"), minutes: z.number().positive() }),
    ]),
  },
  normalizeInput: async ({ departureAt, belongings }) => ({
    departureAt,
    belongings: belongings.map((belonging) => ({
      ...belonging,
      chargePercent: belonging.chargePercent ?? null,
    })),
  }),
  planning: {
    instructions: "出発時刻までに必要な持ち物と充電状態を整える",
    objectives: ["必要な持ち物を揃える", "必要な機器を充電する"],
  },
  replanning: {
    instructions: "遅延の影響を受ける準備だけを更新する",
    defaultMode: "automatic",
  },
  capabilities: [],
  completionPolicy: "automatic",
});

export const outingGoal: ExecutionGoal = {
  id: "ready-to-leave",
  description: "必要な持ち物を揃え、機器を充電して出発できる",
  successCriteria: [
    {
      id: "packed",
      description: "必要な持ち物がすべて梱包済みである",
      evaluator: { type: "state_rule" },
    },
    {
      id: "charged",
      description: "必要な機器が充電済みである",
      evaluator: { type: "state_rule" },
    },
  ],
  completionPolicy: "automatic",
};

/** Default charge wait timer id on the charge step (Voice Suspend demo). */
export const OUTING_CHARGE_TIMER_ID = "charge-wait";

const DEFAULT_PACK_SECONDS = 60;
const DEFAULT_CHARGE_SECONDS = 300;
/** Extra seconds added to charge when a delay event triggers replan. */
export const OUTING_DELAY_CHARGE_EXTENSION_SECONDS = 60;

/**
 * Build a parallel pack + charge plan from normalized outing input.
 * Items without chargePercent are pack-only; items with a number need charging.
 */
export function buildOutingPlan(
  normalizedInput: OutingNormalizedInput,
  options?: { planId?: string; version?: number },
): ExecutionPlan<OutingStepData> {
  const packIds = normalizedInput.belongings.map((b) => b.id);
  if (packIds.length === 0) {
    throw new Error("Outing plan requires at least one belonging");
  }
  const chargeIds = normalizedInput.belongings
    .filter((b) => b.chargePercent !== null)
    .map((b) => b.id);

  const steps: ExecutionPlan<OutingStepData>["steps"] = [
    {
      id: "pack",
      label: "Pack belongings",
      summary: "Gather items needed to leave",
      instructions: `Pack: ${packIds.join(", ")}`,
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: DEFAULT_PACK_SECONDS,
      timers: [],
      domainData: { belongingIds: packIds },
    },
  ];

  if (chargeIds.length > 0) {
    steps.push({
      id: "charge",
      label: "Charge devices",
      summary: "Bring device charge to a usable level",
      instructions: `Charge: ${chargeIds.join(", ")}. You can suspend voice while waiting.`,
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: DEFAULT_CHARGE_SECONDS,
      timers: [
        {
          id: OUTING_CHARGE_TIMER_ID,
          label: "Charge wait",
          durationSeconds: DEFAULT_CHARGE_SECONDS,
          autoStart: false,
        },
      ],
      domainData: { belongingIds: chargeIds },
    });
  }

  return {
    id: options?.planId ?? "outing-plan",
    version: options?.version ?? 1,
    title: "Outing preparation",
    metadata: {
      domainId: outingDomain.id,
      domainVersion: outingDomain.version,
    },
    goal: outingGoal,
    steps,
  };
}

/**
 * Initial WorldState facts from normalized input (empty packed set, charge map).
 */
export function buildOutingWorldState(
  normalizedInput: OutingNormalizedInput,
  options?: { updatedAt?: Date },
): WorldState {
  const chargeByBelongingId: Record<string, number | null> = {};
  for (const belonging of normalizedInput.belongings) {
    chargeByBelongingId[belonging.id] = belonging.chargePercent;
  }

  return createWorldStateFromDomainFacts(
    outingDomain.schemas.worldState,
    {
      departureAt: normalizedInput.departureAt,
      packedBelongingIds: [],
      chargeByBelongingId,
    },
    { updatedAt: options?.updatedAt ?? new Date() },
  );
}

/** Static fixture plan (parallel pack + charge) for tests and default demos. */
export const outingPlan: ExecutionPlan<OutingStepData> = buildOutingPlan({
  departureAt: "2026-07-11T03:00:00Z",
  belongings: [
    { id: "keys", name: "Keys", chargePercent: null },
    { id: "phone", name: "Phone", chargePercent: 20 },
  ],
});

export const initialOutingWorldState: WorldState = buildOutingWorldState(
  {
    departureAt: "2026-07-11T03:00:00Z",
    belongings: [
      { id: "keys", name: "Keys", chargePercent: null },
      { id: "phone", name: "Phone", chargePercent: 20 },
    ],
  },
  { updatedAt: new Date("2026-07-11T00:00:00.000Z") },
);

/** Minimal event shape for static replan assess (Cloudflare-agnostic). */
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

/**
 * Static assess: a delay domain event impacts the charge step (if present).
 */
export function assessOutingDelayReplan(input: {
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
  return {
    needsReplan: true,
    causeEventIds: [cause.id],
    directlyAffectedStepIds: ["charge"],
    reason: "A delay changes the charging window",
  };
}

const REPLAN_AUDIT_EVENT_TYPES = new Set(["replan_proposed", "replan_failed", "plan_updated"]);

function isContinuationEventType(type: string): boolean {
  return type.startsWith("continuation_");
}

/**
 * Static patch: extend charge duration after delay (demo-friendly deterministic patch).
 */
export function buildOutingDelayPatch(input: {
  plan: ExecutionPlan;
  assessment: ReplanAssessment;
  affectedStepIds: readonly string[];
  recentEvents: readonly OutingReplanEventLike[];
  patchId?: string;
}): PlanPatch {
  const charge = input.plan.steps.find(({ id }) => id === "charge");
  if (!charge) {
    throw new Error("Outing plan has no charge step to replan");
  }

  const baseLastEventId =
    input.recentEvents
      .filter(({ type }) => !REPLAN_AUDIT_EVENT_TYPES.has(type) && !isContinuationEventType(type))
      .at(-1)?.id ?? null;

  const nextDuration = charge.estimatedDurationSeconds + OUTING_DELAY_CHARGE_EXTENSION_SECONDS;
  const nextTimers = Array.isArray(charge.timers)
    ? charge.timers.map((timer) => {
        if (
          typeof timer === "object" &&
          timer !== null &&
          !Array.isArray(timer) &&
          "id" in timer &&
          timer.id === OUTING_CHARGE_TIMER_ID
        ) {
          return { ...timer, durationSeconds: nextDuration };
        }
        return timer;
      })
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

/**
 * Domain WorldState reconcile policy for replan activation.
 * Validates facts against the Domain schema and records plan utilization.
 */
export function reconcileOutingWorldState(plan: ExecutionPlan, worldState: WorldState): WorldState {
  outingDomain.schemas.worldState.parse(worldState.facts);
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
