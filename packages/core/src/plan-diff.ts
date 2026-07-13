import type { ExecutionPlan, ExecutionStep } from "./plan.js";

export type PlanFieldChange = {
  stepId: string;
  field: string;
  before: unknown;
  after: unknown;
};

export type PlanDiff = {
  addedStepIds: string[];
  removedStepIds: string[];
  updatedStepIds: string[];
  fieldChanges: PlanFieldChange[];
  durationDeltaSeconds: number;
};

const COMPARE_FIELDS = [
  "label",
  "summary",
  "instructions",
  "estimatedDurationSeconds",
  "executor",
  "after",
  "requirements",
  "resourceRequirements",
  "timeline",
  "timers",
  "notes",
  "domainData",
] as const;

/**
 * CE-21: structural diff between two plans (for improve UI / replan summaries).
 */
export function diffPlans(before: ExecutionPlan, after: ExecutionPlan): PlanDiff {
  const beforeIds = new Set(before.steps.map((s) => s.id));
  const afterIds = new Set(after.steps.map((s) => s.id));

  const addedStepIds = after.steps.map((s) => s.id).filter((id) => !beforeIds.has(id));
  const removedStepIds = before.steps.map((s) => s.id).filter((id) => !afterIds.has(id));

  const beforeById = new Map(before.steps.map((s) => [s.id, s]));
  const fieldChanges: PlanFieldChange[] = [];
  const updated = new Set<string>();

  for (const step of after.steps) {
    const prev = beforeById.get(step.id);
    if (!prev) continue;
    for (const field of COMPARE_FIELDS) {
      const a = prev[field as keyof ExecutionStep];
      const b = step[field as keyof ExecutionStep];
      if (!stableEqual(a, b)) {
        updated.add(step.id);
        fieldChanges.push({ stepId: step.id, field, before: a, after: b });
      }
    }
  }

  const durationBefore = before.steps.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);
  const durationAfter = after.steps.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);

  return {
    addedStepIds,
    removedStepIds,
    updatedStepIds: [...updated],
    fieldChanges,
    durationDeltaSeconds: durationAfter - durationBefore,
  };
}

function stableEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}
