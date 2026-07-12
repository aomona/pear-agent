import {
  createWorldStateFromDomainFacts,
  defineDomain,
  freeTextValueSchema,
  PlanPatchValidationError,
  resolveMaybeFreeTextField,
  type ExecutionGoal,
  type ExecutionPlan,
  type NormalizeInputContext,
  type PlanPatch,
  type ReplanAssessment,
  type WorldState,
} from "@pear-agent/core";
import { z } from "zod";

export {
  isOutingFreeTextField,
  outingFreeTextGeminiSchemas,
  outingFreeTextHints,
  outingFreeTextParse,
  unwrapOutingFreeTextGeminiResult,
  OUTING_FREE_TEXT_FIELDS,
  type OutingFreeTextField,
} from "./free-text-fields.js";
import { outingFreeTextHints, outingFreeTextParse } from "./free-text-fields.js";

const belongingInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  chargePercent: z.number().min(0).max(100).optional(),
});

const belongingSchema = belongingInputSchema.extend({
  chargePercent: z.number().min(0).max(100).nullable(),
});

const taskInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  estimatedDurationSeconds: z.number().positive().optional(),
  notes: z.string().max(500).optional(),
});

const taskSchema = taskInputSchema.extend({
  estimatedDurationSeconds: z.number().positive().nullable(),
  notes: z.string().max(500).nullable(),
});

const placeLabelSchema = z.string().trim().min(1).max(160);

/** Domain-specific facts stored in WorldState.facts (not the Core envelope). */
const outingWorldStateFactsSchema = z.object({
  departureAt: z.iso.datetime(),
  packedBelongingIds: z.array(z.string().min(1)),
  chargeByBelongingId: z.record(z.string(), z.number().min(0).max(100).nullable()),
});

/**
 * Each list/scalar field accepts structured data OR free-text (`{ freeText }`).
 * Free text is resolved only via host freeTextResolver (typically Gemini) —
 * see {@link outingFreeTextParse} / free-text-fields registry. No Domain-side
 * deterministic free-text path.
 */
const outingInputSchema = z
  .object({
    departureAt: z.union([z.iso.datetime(), freeTextValueSchema]),
    /** Empty array allowed when tasks are present. */
    belongings: z.union([z.array(belongingInputSchema), freeTextValueSchema]).optional(),
    tasks: z.union([z.array(taskInputSchema), freeTextValueSchema]).optional(),
    originLabel: z.union([placeLabelSchema, freeTextValueSchema]).optional(),
    destinationLabel: z.union([placeLabelSchema, freeTextValueSchema]).optional(),
  })
  .superRefine((value, ctx) => {
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
      ctx.addIssue({
        code: "custom",
        message: "At least one belonging or task is required",
        path: ["belongings"],
      });
    }
  });

const outingNormalizedInputSchema = z
  .object({
    departureAt: z.iso.datetime(),
    belongings: z.array(belongingSchema),
    tasks: z.array(taskSchema),
    originLabel: placeLabelSchema.nullable(),
    destinationLabel: placeLabelSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.belongings.length === 0 && value.tasks.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "At least one belonging or task is required",
        path: ["belongings"],
      });
    }
  });

const outingStepDataSchema = z.object({
  kind: z.enum(["pack", "charge", "task"]).optional(),
  belongingIds: z.array(z.string().min(1)),
  taskId: z.string().min(1).optional(),
});

export type OutingInput = z.infer<typeof outingInputSchema>;
export type OutingNormalizedInput = z.infer<typeof outingNormalizedInputSchema>;
export type OutingStepData = z.infer<typeof outingStepDataSchema>;
export type OutingBelongingInput = z.infer<typeof belongingInputSchema>;
export type OutingTaskInput = z.infer<typeof taskInputSchema>;
export type OutingTask = z.infer<typeof taskSchema>;

async function resolveOptionalLabel(
  field: "originLabel" | "destinationLabel",
  value: string | { freeText: string } | undefined,
  fieldOpts: {
    domainId: string;
    freeTextResolver?: NormalizeInputContext["freeTextResolver"];
    context?: unknown;
  },
): Promise<string | null> {
  if (value === undefined) return null;
  if (typeof value === "string") return outingFreeTextParse[field](value);
  return resolveMaybeFreeTextField({
    ...fieldOpts,
    field,
    value,
    parse: outingFreeTextParse[field],
    hint: outingFreeTextHints[field],
  });
}

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
  normalizeInput: async (input, ctx?: NormalizeInputContext) => {
    const fieldOpts = {
      domainId: "outing",
      ...(ctx?.freeTextResolver !== undefined ? { freeTextResolver: ctx.freeTextResolver } : {}),
      ...(ctx?.context !== undefined ? { context: ctx.context } : {}),
    };

    const departureAt = await resolveMaybeFreeTextField({
      ...fieldOpts,
      field: "departureAt",
      value: input.departureAt,
      parse: outingFreeTextParse.departureAt,
      hint: outingFreeTextHints.departureAt,
    });

    const belongingsRaw = input.belongings ?? [];
    const belongings = await resolveMaybeFreeTextField({
      ...fieldOpts,
      field: "belongings",
      value: belongingsRaw,
      parse: outingFreeTextParse.belongings,
      hint: outingFreeTextHints.belongings,
    });

    const tasksRaw = input.tasks ?? [];
    const tasks = await resolveMaybeFreeTextField({
      ...fieldOpts,
      field: "tasks",
      value: tasksRaw,
      parse: outingFreeTextParse.tasks,
      hint: outingFreeTextHints.tasks,
    });

    const originLabel = await resolveOptionalLabel("originLabel", input.originLabel, fieldOpts);
    const destinationLabel = await resolveOptionalLabel(
      "destinationLabel",
      input.destinationLabel,
      fieldOpts,
    );

    return {
      departureAt,
      belongings: belongings.map((belonging) => ({
        ...belonging,
        chargePercent: belonging.chargePercent ?? null,
      })),
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        estimatedDurationSeconds: task.estimatedDurationSeconds ?? null,
        notes: task.notes ?? null,
      })),
      originLabel,
      destinationLabel,
    };
  },
  planning: {
    instructions:
      "出発時刻・行き先までに必要な持ち物・充電・準備タスクを整える。並行可能な準備は並列 step にする。",
    objectives: ["必要な持ち物を揃える", "必要な機器を充電する", "出発前の準備タスクを完了する"],
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
  description: "必要な持ち物を揃え、機器を充電して出発できる（準備タスクは step 完了で追跡）",
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
const DEFAULT_TASK_SECONDS = 60;
/** Extra seconds added to charge when a delay event triggers replan. */
export const OUTING_DELAY_CHARGE_EXTENSION_SECONDS = 60;

function placeRouteTitle(input: OutingNormalizedInput): string {
  const from = input.originLabel;
  const to = input.destinationLabel;
  if (from && to) return `${from} → ${to}`;
  if (to) return `To ${to}`;
  if (from) return `From ${from}`;
  return "Outing preparation";
}

/**
 * Build a parallel pack + charge + task plan from normalized outing input.
 * Belongings and/or tasks required (validated by schema).
 */
export function buildOutingPlan(
  normalizedInput: OutingNormalizedInput,
  options?: { planId?: string; version?: number },
): ExecutionPlan<OutingStepData> {
  if (normalizedInput.belongings.length === 0 && normalizedInput.tasks.length === 0) {
    throw new Error("Outing plan requires at least one belonging or task");
  }

  const steps: ExecutionPlan<OutingStepData>["steps"] = [];
  const packIds = normalizedInput.belongings.map((b) => b.id);
  const chargeIds = normalizedInput.belongings
    .filter((b) => b.chargePercent !== null)
    .map((b) => b.id);

  const routeHint =
    normalizedInput.originLabel || normalizedInput.destinationLabel
      ? ` Route: ${placeRouteTitle(normalizedInput)}.`
      : "";

  if (packIds.length > 0) {
    steps.push({
      id: "pack",
      label: "Pack belongings",
      summary: "Gather items needed to leave",
      instructions: `Pack: ${packIds.join(", ")}.${routeHint}`,
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: DEFAULT_PACK_SECONDS,
      timers: [],
      domainData: { kind: "pack", belongingIds: packIds },
    });
  }

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
      domainData: { kind: "charge", belongingIds: chargeIds },
    });
  }

  for (const task of normalizedInput.tasks) {
    const duration = task.estimatedDurationSeconds ?? DEFAULT_TASK_SECONDS;
    steps.push({
      id: `task:${task.id}`,
      label: task.title,
      summary: task.notes ?? "Prep task before departure",
      instructions: task.notes
        ? `${task.title}. ${task.notes}.${routeHint}`
        : `${task.title}.${routeHint}`,
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: duration,
      timers: [],
      domainData: { kind: "task", belongingIds: [], taskId: task.id },
    });
  }

  if (steps.length === 0) {
    throw new Error("Outing plan produced no steps");
  }

  const metadata: Record<string, string | number | boolean | null> = {
    domainId: outingDomain.id,
    domainVersion: outingDomain.version,
  };
  if (normalizedInput.originLabel) metadata.originLabel = normalizedInput.originLabel;
  if (normalizedInput.destinationLabel) {
    metadata.destinationLabel = normalizedInput.destinationLabel;
  }

  return {
    id: options?.planId ?? "outing-plan",
    version: options?.version ?? 1,
    title: placeRouteTitle(normalizedInput),
    metadata,
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

const defaultFixtureInput: OutingNormalizedInput = {
  departureAt: "2026-07-11T03:00:00Z",
  belongings: [
    { id: "keys", name: "Keys", chargePercent: null },
    { id: "phone", name: "Phone", chargePercent: 20 },
  ],
  tasks: [],
  originLabel: null,
  destinationLabel: null,
};

/** Static fixture plan (parallel pack + charge) for tests and default demos. */
export const outingPlan: ExecutionPlan<OutingStepData> = buildOutingPlan(defaultFixtureInput);

export const initialOutingWorldState: WorldState = buildOutingWorldState(defaultFixtureInput, {
  updatedAt: new Date("2026-07-11T00:00:00.000Z"),
});

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
