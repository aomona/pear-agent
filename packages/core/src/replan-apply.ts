import { z } from "zod";

import { resolveExecutionMode, type ExecutionMode } from "./actor.js";
import { executionPlanSchema, type ExecutionPlan } from "./plan.js";
import { stepStatesSchema, type StepStates } from "./step-state.js";
import { worldStateSchema } from "./world-state.js";
import {
  affectedSubgraphSchema,
  planPatchSchema,
  PlanPatchValidationError,
  replanCapabilityPolicySchema,
  replanModeSchema,
  type AffectedSubgraph,
  type ApplyPlanPatchInput,
  type ApplyPlanPatchResult,
  type PlanPatch,
  type PlanPatchDiff,
  type ReplanCapabilityPolicy,
  type ReplanMode,
} from "./replan-schemas.js";

const REPLAN_MODE_RANK: Record<ExecutionMode, number> = {
  automatic: 0,
  confirm: 1,
  suggest: 2,
};

/** A caller may request stricter handling, but can never weaken Domain policy. */
export function mostRestrictiveReplanMode(
  ...modes: readonly (ReplanMode | undefined)[]
): ReplanMode {
  return modes
    .filter((mode): mode is ReplanMode => mode !== undefined)
    .map((mode) => replanModeSchema.parse(mode))
    .reduce<ReplanMode>(
      (strictest, mode) =>
        REPLAN_MODE_RANK[mode] > REPLAN_MODE_RANK[strictest] ? mode : strictest,
      "automatic",
    );
}

/** Escalate a patch for the execution policies of added/updated capabilities. */
export function resolvePlanPatchMode(input: {
  defaultMode: ReplanMode;
  requestedMode?: ReplanMode;
  patch: PlanPatch;
  capabilityPolicies: readonly ReplanCapabilityPolicy[];
}): ReplanMode {
  const patch = planPatchSchema.parse(input.patch);
  const policies = new Map<string, ReplanCapabilityPolicy>();
  for (const policy of input.capabilityPolicies) {
    const parsed = replanCapabilityPolicySchema.parse(policy);
    if (policies.has(parsed.id)) {
      throw new PlanPatchValidationError(`Duplicate capability policy: ${parsed.id}`);
    }
    policies.set(parsed.id, parsed);
  }
  const modes: ReplanMode[] = [input.defaultMode, input.requestedMode ?? input.defaultMode];
  for (const operation of patch.operations) {
    if (operation.type === "remove_step" || operation.step.executor.type !== "agent") continue;
    const policy = policies.get(operation.step.executor.capabilityId);
    if (!policy) {
      throw new PlanPatchValidationError(
        `Unknown capability ${operation.step.executor.capabilityId} for step ${operation.step.id}`,
      );
    }
    modes.push(
      resolveExecutionMode({
        configuredMode: policy.executionMode,
        riskLevel: policy.riskLevel,
      }),
    );
  }
  return mostRestrictiveReplanMode(...modes);
}

/** Expand directly affected roots to every downstream dependent in the DAG. */
export function analyzeAffectedSubgraph(
  plan: ExecutionPlan,
  directlyAffectedStepIds: readonly string[],
): AffectedSubgraph {
  const parsedPlan = executionPlanSchema(z.unknown()).parse(plan);
  const knownIds = new Set(parsedPlan.steps.map(({ id }) => id));
  const roots = [...new Set(directlyAffectedStepIds)];
  for (const stepId of roots) {
    if (!knownIds.has(stepId)) {
      throw new PlanPatchValidationError(`Unknown directly affected step: ${stepId}`);
    }
  }

  const affected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of parsedPlan.steps) {
      if (!affected.has(step.id) && step.after.some((dependency) => affected.has(dependency))) {
        affected.add(step.id);
        changed = true;
      }
    }
  }
  return affectedSubgraphSchema.parse({ rootStepIds: roots, stepIds: [...affected] });
}

/** Validate and apply a partial patch without mutating its inputs. */
export function applyPlanPatch(input: ApplyPlanPatchInput): ApplyPlanPatchResult {
  const plan = executionPlanSchema(z.unknown()).parse(input.plan);
  const stepStates = stepStatesSchema.parse(input.stepStates);
  const worldState = worldStateSchema.parse(input.worldState);
  const patch = planPatchSchema.parse(input.patch);
  if (patch.basePlanId !== plan.id || patch.basePlanVersion !== plan.version) {
    throw new PlanPatchValidationError("Patch base plan does not match the active plan version");
  }

  const appliedEventIds = new Set(input.appliedEventIds);
  if (patch.baseLastEventId !== input.currentLastEventId) {
    throw new PlanPatchValidationError("Patch event cursor is stale");
  }
  for (const eventId of patch.causeEventIds) {
    if (!appliedEventIds.has(eventId)) {
      throw new PlanPatchValidationError(`Unknown cause event: ${eventId}`);
    }
  }

  const affected = new Set(patch.affectedStepIds);
  const steps = new Map(plan.steps.map((step) => [step.id, structuredClone(step)]));
  const touched = new Set<string>();
  const activeStepIds = new Set<string>();
  const confirmationRequiredStepIds = new Set<string>();
  const diff: PlanPatchDiff = { addedStepIds: [], updatedStepIds: [], removedStepIds: [] };

  for (const operation of patch.operations) {
    const stepId = operation.type === "add_step" ? operation.step.id : operation.stepId;
    if (!affected.has(stepId)) {
      throw new PlanPatchValidationError(`Patch operation touches unaffected step: ${stepId}`);
    }
    if (touched.has(stepId)) {
      throw new PlanPatchValidationError(`Patch contains multiple operations for step: ${stepId}`);
    }
    touched.add(stepId);

    if (operation.type === "add_step") {
      if (steps.has(stepId)) throw new PlanPatchValidationError(`Step already exists: ${stepId}`);
      steps.set(stepId, structuredClone(operation.step));
      diff.addedStepIds.push(stepId);
      continue;
    }

    const existing = steps.get(stepId);
    if (!existing) throw new PlanPatchValidationError(`Unknown patch step: ${stepId}`);
    const status = stepStates[stepId]?.status;
    if (status === "completed" || status === "skipped") {
      throw new PlanPatchValidationError(`Cannot change ${status} step: ${stepId}`);
    }
    if (status === "active") activeStepIds.add(stepId);
    if (status === "paused" || status === "failed" || status === "active") {
      confirmationRequiredStepIds.add(stepId);
    }

    if (operation.type === "update_step") {
      if (operation.step.id !== stepId) {
        throw new PlanPatchValidationError(`Updated step id must remain ${stepId}`);
      }
      steps.set(stepId, structuredClone(operation.step));
      diff.updatedStepIds.push(stepId);
    } else {
      steps.delete(stepId);
      diff.removedStepIds.push(stepId);
    }
  }

  if (input.phase === "activation") {
    if (activeStepIds.size > 0) {
      throw new PlanPatchValidationError(
        "Active steps must be paused before a confirmed patch can be applied",
      );
    }
    const needsHumanConfirm = [...confirmationRequiredStepIds].filter((stepId) => {
      const status = stepStates[stepId]?.status;
      return status === "paused" || status === "failed";
    });
    if (needsHumanConfirm.length > 0 && input.humanConfirmed !== true) {
      throw new PlanPatchValidationError(
        "Paused or failed step changes require human confirmation",
      );
    }
  }

  let nextPlan = executionPlanSchema(z.unknown()).parse({
    ...plan,
    version: plan.version + 1,
    steps: [...steps.values()],
  });

  if (input.stepDataSchema !== undefined) {
    const stepDataSchema = input.stepDataSchema;
    nextPlan = executionPlanSchema(z.unknown()).parse({
      ...nextPlan,
      steps: nextPlan.steps.map((step) => {
        // Persisted data is already Domain output and a transform need not be
        // idempotent on its own output. Parse/normalize only generated data
        // for touched steps; Domain-version provenance protects untouched work.
        if (!touched.has(step.id)) return step;
        const parsedDomainData = stepDataSchema.parse(structuredClone(step.domainData));
        return { ...step, domainData: parsedDomainData };
      }),
    });
  }

  if (input.capabilityIds !== undefined) {
    const capabilityIds = new Set(input.capabilityIds);
    for (const step of nextPlan.steps) {
      if (step.executor.type === "agent" && !capabilityIds.has(step.executor.capabilityId)) {
        throw new PlanPatchValidationError(
          `Unknown capability ${step.executor.capabilityId} for step ${step.id}`,
        );
      }
    }
  }
  const nextWorldState = input.reconcileWorldState
    ? worldStateSchema.parse(
        input.reconcileWorldState(structuredClone(nextPlan), structuredClone(worldState)),
      )
    : worldState;

  return {
    plan: nextPlan,
    worldState: nextWorldState,
    diff,
    activeStepIds: [...activeStepIds],
    confirmationRequiredStepIds: [...confirmationRequiredStepIds],
  };
}

/** Order-insensitive set equality for step/event id lists. */
export function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/**
 * Ensures a generated patch only touches the Runtime-approved subgraph, plus
 * newly added steps that appear in both `affectedStepIds` and add operations.
 */
export function assertPatchMatchesApprovedSubgraph(
  plan: ExecutionPlan,
  patch: PlanPatch,
  expectedAffectedStepIds: readonly string[],
): void {
  const parsedPlan = executionPlanSchema(z.unknown()).parse(plan);
  const parsedPatch = planPatchSchema.parse(patch);
  const knownStepIds = new Set(parsedPlan.steps.map(({ id }) => id));
  const addedStepIds = parsedPatch.operations
    .filter((operation) => operation.type === "add_step")
    .map((operation) => operation.step.id);
  const existingAffected = parsedPatch.affectedStepIds.filter((stepId) => knownStepIds.has(stepId));
  const newAffected = parsedPatch.affectedStepIds.filter((stepId) => !knownStepIds.has(stepId));
  if (
    !sameIdSet(existingAffected, expectedAffectedStepIds) ||
    !sameIdSet(newAffected, addedStepIds)
  ) {
    throw new PlanPatchValidationError(
      "Patch affected steps differ from the Runtime-approved subgraph",
    );
  }
}

/** Event types that do not advance the replan operational cursor. */
export function isReplanNonOperationalEventType(type: string): boolean {
  return (
    type === "replan_proposed" ||
    type === "replan_failed" ||
    type === "plan_updated" ||
    type.startsWith("continuation_")
  );
}

export function lastOperationalEventId(
  events: readonly { id: string; type: string }[],
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && !isReplanNonOperationalEventType(event.type)) return event.id;
  }
  return null;
}

/** Replace AI step payloads with the Domain-normalized candidate persisted by the Runtime. */
export function normalizePlanPatchSteps(patch: PlanPatch, validatedPlan: ExecutionPlan): PlanPatch {
  const parsedPatch = planPatchSchema.parse(patch);
  const steps = new Map(validatedPlan.steps.map((step) => [step.id, step]));
  return planPatchSchema.parse({
    ...parsedPatch,
    operations: parsedPatch.operations.map((operation) => {
      if (operation.type === "remove_step") return operation;
      const step = steps.get(operation.step.id);
      if (!step) {
        throw new PlanPatchValidationError(
          `Validated plan is missing patched step: ${operation.step.id}`,
        );
      }
      return operation.type === "add_step"
        ? { ...operation, step }
        : { ...operation, stepId: step.id, step };
    }),
  });
}

/** Inspect which patched steps are active or need human confirmation. */
export function inspectPatchSteps(
  patch: PlanPatch,
  stepStates: StepStates,
): { activeStepIds: string[]; confirmationRequiredStepIds: string[] } {
  const parsedPatch = planPatchSchema.parse(patch);
  const parsedStates = stepStatesSchema.parse(stepStates);
  const activeStepIds: string[] = [];
  const confirmationRequiredStepIds: string[] = [];
  for (const operation of parsedPatch.operations) {
    const stepId = operation.type === "add_step" ? operation.step.id : operation.stepId;
    const status = parsedStates[stepId]?.status;
    if (status === "active") activeStepIds.push(stepId);
    if (status === "active" || status === "paused" || status === "failed") {
      confirmationRequiredStepIds.push(stepId);
    }
  }
  return { activeStepIds, confirmationRequiredStepIds };
}
