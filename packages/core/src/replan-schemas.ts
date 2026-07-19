import { z } from "zod";

import { executionModeSchema, riskLevelSchema } from "./actor.js";
import { runtimeEventSchema } from "./event.js";
import { executionGoalSchema } from "./goal.js";
import { executionPlanSchema, executionStepSchema, type ExecutionPlan } from "./plan.js";
import { type StepStates } from "./step-state.js";
import { worldStateSchema, type WorldState } from "./world-state.js";
import { planChangeCauseRefSchema, type PlanChangeCauseRef } from "./compiler.js";

export const replanModeSchema = executionModeSchema;
export type ReplanMode = z.infer<typeof replanModeSchema>;

export const replanCapabilityPolicySchema = z
  .object({
    id: z.string().min(1),
    executionMode: executionModeSchema,
    riskLevel: riskLevelSchema,
  })
  .strict();
export type ReplanCapabilityPolicy = z.infer<typeof replanCapabilityPolicySchema>;

export const assessInputSchema = z.object({
  goal: executionGoalSchema,
  plan: executionPlanSchema(z.unknown()),
  worldState: worldStateSchema,
  recentEvents: z.array(runtimeEventSchema),
});
export type AssessInput = z.infer<typeof assessInputSchema>;

export const replanAssessmentSchema = z
  .object({
    needsReplan: z.boolean(),
    causeEventIds: z.array(z.string().min(1)).max(100),
    directlyAffectedStepIds: z.array(z.string().min(1)).max(1_000),
    reason: z.string().min(1).max(2_000),
  })
  .strict();
export type ReplanAssessment = z.infer<typeof replanAssessmentSchema>;

export const affectedSubgraphSchema = z.object({
  rootStepIds: z.array(z.string().min(1)),
  stepIds: z.array(z.string().min(1)),
});
export type AffectedSubgraph = z.infer<typeof affectedSubgraphSchema>;

const addStepOperationSchema = z
  .object({
    type: z.literal("add_step"),
    step: executionStepSchema(z.unknown()),
  })
  .strict();
const updateStepOperationSchema = z
  .object({
    type: z.literal("update_step"),
    stepId: z.string().min(1),
    step: executionStepSchema(z.unknown()),
  })
  .strict();
const removeStepOperationSchema = z
  .object({
    type: z.literal("remove_step"),
    stepId: z.string().min(1),
  })
  .strict();

export const planPatchOperationSchema = z.discriminatedUnion("type", [
  addStepOperationSchema,
  updateStepOperationSchema,
  removeStepOperationSchema,
]);
export type PlanPatchOperation = z.infer<typeof planPatchOperationSchema>;

export const planPatchSchema = z
  .object({
    id: z.string().min(1).max(200),
    basePlanId: z.string().min(1),
    basePlanVersion: z.number().int().positive(),
    baseLastEventId: z.string().min(1).nullable(),
    causeEventIds: z.array(z.string().min(1)).min(1).max(100),
    causeRefs: z.array(planChangeCauseRefSchema).min(1).max(100).optional(),
    affectedStepIds: z.array(z.string().min(1)).min(1).max(1_000),
    operations: z.array(planPatchOperationSchema).min(1).max(1_000),
    summary: z.string().min(1).max(2_000),
  })
  .strict();
export type PlanPatch = z.infer<typeof planPatchSchema>;

export function resolvePlanPatchCauseRefs(patch: PlanPatch): PlanChangeCauseRef[] {
  return (
    patch.causeRefs ??
    patch.causeEventIds.map((eventId) => ({ type: "runtime_event" as const, eventId }))
  );
}

export const planPatchStatusSchema = z.enum([
  "suggested",
  "pending_confirmation",
  "applied",
  "failed",
]);
export type PlanPatchStatus = z.infer<typeof planPatchStatusSchema>;

export const planChangeSchema = z.object({
  patch: planPatchSchema,
  mode: replanModeSchema,
  status: planPatchStatusSchema,
  targetPlanVersion: z.number().int().positive().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  activeStepIdsAtProposal: z.array(z.string().min(1)).default([]),
  validationDomainVersion: z.number().int().positive(),
  validationNormalizedInputRevision: z.number().int().positive().nullable().default(null),
});
export type PlanChange = z.infer<typeof planChangeSchema>;

export type PlanPatchDiff = {
  addedStepIds: string[];
  updatedStepIds: string[];
  removedStepIds: string[];
};

/** Proposal builds a candidate without human confirmation gates; activation enforces them. */
export type PlanPatchPhase = "proposal" | "activation";

export type ApplyPlanPatchInput = {
  plan: ExecutionPlan;
  stepStates: StepStates;
  worldState: WorldState;
  appliedEventIds: readonly string[];
  /** Operational cursor (excludes replan/continuation audit events). Required. */
  currentLastEventId: string | null;
  patch: PlanPatch;
  phase: PlanPatchPhase;
  /** Activation only: human confirmed paused/failed (and interrupted active) steps. */
  humanConfirmed?: boolean;
  capabilityIds?: readonly string[];
  reconcileWorldState?: (plan: ExecutionPlan, worldState: WorldState) => WorldState;
  stepDataSchema?: z.ZodType;
};

export type ApplyPlanPatchResult = {
  plan: ExecutionPlan;
  worldState: WorldState;
  diff: PlanPatchDiff;
  activeStepIds: string[];
  confirmationRequiredStepIds: string[];
};

export class PlanPatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanPatchValidationError";
  }
}
