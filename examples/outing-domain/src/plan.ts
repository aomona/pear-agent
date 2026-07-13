import {
  createWorldStateFromDomainFacts,
  type ExecutionGoal,
  type ExecutionPlan,
  type WorldState,
} from "@pear-agent/core";

import {
  OUTING_DOMAIN_ID,
  OUTING_DOMAIN_VERSION,
  outingWorldStateFactsSchema,
  type OutingNormalizedInput,
  type OutingStepData,
} from "./schemas.js";

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

export const OUTING_CHARGE_TIMER_ID = "charge-wait";
export const OUTING_DELAY_CHARGE_EXTENSION_SECONDS = 60;
const DEFAULT_PACK_SECONDS = 60;
const DEFAULT_CHARGE_SECONDS = 300;
const DEFAULT_TASK_SECONDS = 60;

function placeRouteTitle(input: OutingNormalizedInput): string {
  if (input.originLabel && input.destinationLabel) {
    return `${input.originLabel} → ${input.destinationLabel}`;
  }
  if (input.destinationLabel) return `To ${input.destinationLabel}`;
  if (input.originLabel) return `From ${input.originLabel}`;
  return "Outing preparation";
}

export function buildOutingPlan(
  normalizedInput: OutingNormalizedInput,
  options?: { planId?: string; version?: number },
): ExecutionPlan<OutingStepData> {
  if (normalizedInput.belongings.length === 0 && normalizedInput.tasks.length === 0) {
    throw new Error("Outing plan requires at least one belonging or task");
  }
  const steps: ExecutionPlan<OutingStepData>["steps"] = [];
  const packIds = normalizedInput.belongings.map(({ id }) => id);
  const chargeIds = normalizedInput.belongings
    .filter(({ chargePercent }) => chargePercent !== null)
    .map(({ id }) => id);
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
  const metadata: Record<string, string | number | boolean | null> = {
    domainId: OUTING_DOMAIN_ID,
    domainVersion: OUTING_DOMAIN_VERSION,
  };
  if (normalizedInput.originLabel) metadata.originLabel = normalizedInput.originLabel;
  if (normalizedInput.destinationLabel)
    metadata.destinationLabel = normalizedInput.destinationLabel;
  return {
    id: options?.planId ?? "outing-plan",
    version: options?.version ?? 1,
    title: placeRouteTitle(normalizedInput),
    metadata,
    goal: outingGoal,
    steps,
  };
}

export function buildOutingWorldState(
  normalizedInput: OutingNormalizedInput,
  options?: { updatedAt?: Date },
): WorldState {
  const chargeByBelongingId: Record<string, number | null> = {};
  for (const belonging of normalizedInput.belongings) {
    chargeByBelongingId[belonging.id] = belonging.chargePercent;
  }
  return createWorldStateFromDomainFacts(
    outingWorldStateFactsSchema,
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

export const outingPlan: ExecutionPlan<OutingStepData> = buildOutingPlan(defaultFixtureInput);
export const initialOutingWorldState: WorldState = buildOutingWorldState(defaultFixtureInput, {
  updatedAt: new Date("2026-07-11T00:00:00.000Z"),
});
