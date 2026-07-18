import {
  sourceReferenceSchema,
  type ExecutionGoal,
  type ExecutionPlan,
  type PlanPatchOperation,
  type SourceReference,
} from "@pear-agent/core";
import { z } from "zod";

function assertStepProvenance(
  stepId: string,
  refs: readonly SourceReference[] | undefined,
  knownSourceIds: ReadonlySet<string>,
  options: { requireWhenKnownSources: boolean },
): SourceReference[] {
  const list = refs ?? [];
  if (list.length === 0) {
    if (options.requireWhenKnownSources && knownSourceIds.size > 0) {
      throw new Error(`Step ${stepId} must cite at least one source in sourceRefs`);
    }
    if (options.requireWhenKnownSources && knownSourceIds.size === 0) {
      // Create path always requires refs even if known set empty would be odd — create always requires.
    }
    return [];
  }
  for (const ref of list) {
    if (knownSourceIds.size > 0 && !knownSourceIds.has(ref.sourceId)) {
      throw new Error(`Step ${stepId} references unknown source ${ref.sourceId}`);
    }
  }
  return list.map((ref) => sourceReferenceSchema.parse(ref));
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
      const refs = step.sourceRefs ?? [];
      if (refs.length === 0) {
        throw new Error(`Step ${step.id} must cite at least one source in sourceRefs`);
      }
      const sourceRefsParsed = assertStepProvenance(step.id, refs, knownSourceIds, {
        requireWhenKnownSources: true,
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
        requireWhenKnownSources: knownSourceIds.size > 0,
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

/** Replan path: mint Runtime ids for add_step only; force update_step.id = stepId. */
export function rewritePatchStepIdentity(
  operations: PlanPatchOperation[],
  basePlan: ExecutionPlan,
  createId: () => string,
): PlanPatchOperation[] {
  const knownStepIds = new Set(basePlan.steps.map((step) => step.id));
  const stepIds = new Map<string, string>();
  for (const id of knownStepIds) stepIds.set(id, id);

  for (const op of operations) {
    if (op.type === "add_step") {
      stepIds.set(op.step.id, `step-${createId()}`);
    }
  }

  return operations.map((op) => {
    if (op.type === "add_step") {
      const id = stepIds.get(op.step.id) ?? `step-${createId()}`;
      return {
        type: "add_step" as const,
        step: {
          ...op.step,
          id,
          after: op.step.after.map((dep) => stepIds.get(dep) ?? dep),
        },
      };
    }
    if (op.type === "update_step") {
      return {
        type: "update_step" as const,
        stepId: op.stepId,
        step: {
          ...op.step,
          id: op.stepId,
          after: op.step.after.map((dep) => stepIds.get(dep) ?? dep),
        },
      };
    }
    return op;
  });
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
