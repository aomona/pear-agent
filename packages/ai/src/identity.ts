import {
  sourceReferenceSchema,
  type ExecutionGoal,
  type ExecutionPlan,
  type PlanChangeCauseRef,
  type PlanPatchOperation,
  type SourceReference,
} from "@pear-agent/core";
import { z } from "zod";

function assertStepProvenance(
  stepId: string,
  refs: readonly SourceReference[] | undefined,
  knownSourceIds: ReadonlySet<string>,
  options: { requireRefs: boolean },
): SourceReference[] {
  const list = refs ?? [];
  if (list.length === 0) {
    if (options.requireRefs) {
      throw new Error(`Step ${stepId} must cite at least one source in sourceRefs`);
    }
    return [];
  }
  for (const ref of list) {
    if (!knownSourceIds.has(ref.sourceId)) {
      throw new Error(`Step ${stepId} references unknown source ${ref.sourceId}`);
    }
  }
  return list.map((ref) => sourceReferenceSchema.parse(ref));
}

/** Collect source ids already present on a plan (base-plan provenance). */
export function knownSourceIdsFromPlan(plan: ExecutionPlan): Set<string> {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    for (const ref of step.sourceRefs ?? []) {
      ids.add(ref.sourceId);
    }
  }
  return ids;
}

/** Merge base-plan sources with source-typed cause refs. */
export function knownSourceIdsForReplan(
  plan: ExecutionPlan,
  causeRefs: readonly PlanChangeCauseRef[],
): Set<string> {
  const ids = knownSourceIdsFromPlan(plan);
  for (const cause of causeRefs) {
    if (cause.type === "source") ids.add(cause.sourceId);
  }
  return ids;
}

/** Fresh plan: mint plan/step/timer ids and require provenance against supplied sources. */
export function rewriteCreatedPlanIdentity(
  candidate: ExecutionPlan,
  sourceRefs: readonly SourceReference[],
  createId: () => string,
): ExecutionPlan {
  const knownSourceIds = new Set(sourceRefs.map((ref) => ref.sourceId));
  const planId = `plan-${createId()}`;
  const stepIds = new Map(candidate.steps.map((step) => [step.id, `step-${createId()}`]));
  const timerIds = new Map<string, string>();

  return {
    ...candidate,
    id: planId,
    version: 1,
    steps: candidate.steps.map((step) => {
      const sourceRefsParsed = assertStepProvenance(step.id, step.sourceRefs, knownSourceIds, {
        requireRefs: true,
      });
      return {
        ...step,
        id: stepIds.get(step.id)!,
        after: step.after.map((id) => stepIds.get(id) ?? id),
        timers: step.timers.map((timer) => rewriteTimer(timer, stepIds, timerIds, createId)),
        sourceRefs: sourceRefsParsed,
      };
    }),
  };
}

/** Edit path: pin plan id/version/goal; mint ids only for newly added steps. */
export function rewriteEditedPlanIdentity(
  candidate: ExecutionPlan,
  input: {
    basePlan: ExecutionPlan;
    goal: ExecutionGoal;
    sourceRefs: readonly SourceReference[];
  },
  createId: () => string,
): ExecutionPlan {
  const knownStepIds = new Set(input.basePlan.steps.map((step) => step.id));
  const knownSourceIds = new Set(input.sourceRefs.map((ref) => ref.sourceId));
  const stepIds = new Map<string, string>();
  for (const step of candidate.steps) {
    stepIds.set(step.id, knownStepIds.has(step.id) ? step.id : `step-${createId()}`);
  }

  return {
    ...candidate,
    id: input.basePlan.id,
    version: input.basePlan.version + 1,
    goal: input.goal,
    steps: candidate.steps.map((step) => {
      const refs = assertStepProvenance(step.id, step.sourceRefs, knownSourceIds, {
        // When the host supplied sources, every step must cite them; otherwise omit is ok.
        requireRefs: knownSourceIds.size > 0,
      });
      const nextStep = {
        ...step,
        id: stepIds.get(step.id)!,
        after: step.after.map((id) => stepIds.get(id) ?? id),
      };
      if (refs.length === 0) return nextStep;
      return { ...nextStep, sourceRefs: refs };
    }),
  };
}

export type RewritePatchStepIdentityResult = {
  operations: PlanPatchOperation[];
  /** Model step id → Runtime step id (identity for known base steps). */
  stepIds: ReadonlyMap<string, string>;
  /** Runtime ids minted for add_step operations. */
  addedStepIds: readonly string[];
};

/**
 * Replan path: mint Runtime ids for add_step only; force update_step.id = stepId.
 * Validates source provenance on add/update when known sources exist.
 */
export function rewritePatchStepIdentity(
  operations: PlanPatchOperation[],
  basePlan: ExecutionPlan,
  createId: () => string,
  options?: {
    knownSourceIds?: ReadonlySet<string>;
    causeRefs?: readonly PlanChangeCauseRef[];
  },
): RewritePatchStepIdentityResult {
  const knownStepIds = new Set(basePlan.steps.map((step) => step.id));
  const knownSourceIds =
    options?.knownSourceIds ?? knownSourceIdsForReplan(basePlan, options?.causeRefs ?? []);
  const stepIds = new Map<string, string>();
  for (const id of knownStepIds) stepIds.set(id, id);

  for (const op of operations) {
    if (op.type === "add_step") {
      stepIds.set(op.step.id, `step-${createId()}`);
    }
  }

  const addedStepIds: string[] = [];
  const rewritten = operations.map((op) => {
    if (op.type === "add_step") {
      const id = stepIds.get(op.step.id) ?? `step-${createId()}`;
      addedStepIds.push(id);
      // Validate cited sources; do not require refs on every replan op.
      const sourceRefs = assertStepProvenance(op.step.id, op.step.sourceRefs, knownSourceIds, {
        requireRefs: false,
      });
      return {
        type: "add_step" as const,
        step: {
          ...op.step,
          id,
          after: op.step.after.map((dep) => stepIds.get(dep) ?? dep),
          ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
        },
      };
    }
    if (op.type === "update_step") {
      const sourceRefs = assertStepProvenance(op.stepId, op.step.sourceRefs, knownSourceIds, {
        requireRefs: false,
      });
      return {
        type: "update_step" as const,
        stepId: op.stepId,
        step: {
          ...op.step,
          id: op.stepId,
          after: op.step.after.map((dep) => stepIds.get(dep) ?? dep),
          ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
        },
      };
    }
    return op;
  });

  return { operations: rewritten, stepIds, addedStepIds };
}

/**
 * Rewrite affectedStepIds so add_step model ids become Runtime ids and every
 * minted add_step id is included (required by assertPatchMatchesApprovedSubgraph).
 */
export function rewriteAffectedStepIds(
  affectedStepIds: readonly string[],
  stepIds: ReadonlyMap<string, string>,
  addedStepIds: readonly string[],
): string[] {
  const next = new Set<string>();
  for (const id of affectedStepIds) {
    next.add(stepIds.get(id) ?? id);
  }
  for (const id of addedStepIds) {
    next.add(id);
  }
  return [...next];
}

function rewriteTimer(
  timer: unknown,
  stepIds: Map<string, string>,
  timerIds: Map<string, string>,
  createId: () => string,
): unknown {
  const parsed = z
    .object({
      id: z.string().optional(),
      linkedStepId: z.string().optional(),
    })
    .passthrough()
    .safeParse(timer);
  if (!parsed.success) return timer;
  const nextTimerId =
    typeof parsed.data.id === "string"
      ? (timerIds.get(parsed.data.id) ??
        (() => {
          const id = `timer-${createId()}`;
          timerIds.set(parsed.data.id!, id);
          return id;
        })())
      : undefined;
  return {
    ...parsed.data,
    ...(nextTimerId ? { id: nextTimerId } : {}),
    ...(parsed.data.linkedStepId !== undefined
      ? {
          linkedStepId: stepIds.get(parsed.data.linkedStepId) ?? parsed.data.linkedStepId,
        }
      : {}),
  };
}
