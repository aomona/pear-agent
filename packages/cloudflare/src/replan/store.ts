import {
  applyPlanPatch,
  applyRuntimeEvent,
  assertPatchMatchesApprovedSubgraph,
  inspectPatchSteps,
  materializedExecutionStateSchema,
  planChangeSchema,
  PlanPatchValidationError,
  planPatchSchema,
  replanModeSchema,
  resolvePlanPatchMode,
  runtimeEventSchema,
  sameIdSet,
  worldStateSchema,
  type ExecutionPlan,
  type MaterializedExecutionState,
  type PlanChange,
  type PlanPatch,
  type ReplanCapabilityPolicy,
  type ReplanMode,
  type RuntimeEvent,
  type WorldState,
} from "@pear-agent/core";

import { D1ExecutionStateRepository } from "../d1/repository.js";
import { SessionNotFoundError } from "../errors.js";
import { parseJson, parseRuntimeEvent } from "../serialize.js";
import { activatePlanPatch } from "./activation.js";
import { currentReplanBaseEventId, hasOnlyInterruptionEventsSinceBase } from "./cursor.js";
import { attemptKey, causeKey } from "./keys.js";
import {
  insertEventStatement,
  insertPatchStatement,
  updateMaterializedStatement,
} from "./statements.js";

type PatchRow = {
  id: string;
  session_id: string;
  base_plan_version: number;
  validation_domain_version: number;
  normalized_input_revision: number | null;
  target_plan_version: number | null;
  mode: string;
  status: string;
  patch_json: string;
  candidate_world_state_json: string;
  failure_reason: string | null;
  active_step_ids_json: string;
  created_by_actor_id: string;
  created_at: string;
  updated_at: string;
};

export type ReplanMutationResult = {
  kind: "applied" | "pending_confirmation" | "suggested" | "failed";
  change: PlanChange;
  state: MaterializedExecutionState;
  /** Persisted audit event to deliver to Continuations; null for no-op reads. */
  event: RuntimeEvent | null;
};

function safePatchFailure(caught: unknown): string {
  return caught instanceof PlanPatchValidationError
    ? caught.message.slice(0, 2_000)
    : "Plan patch validation failed";
}

function rowToChange(row: PatchRow): PlanChange {
  return planChangeSchema.parse({
    patch: parseJson(row.patch_json),
    mode: row.mode,
    status: row.status,
    targetPlanVersion: row.target_plan_version,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeStepIdsAtProposal: parseJson(row.active_step_ids_json),
    validationDomainVersion: row.validation_domain_version,
    validationNormalizedInputRevision: row.normalized_input_revision,
  });
}

function auditEvent(input: {
  sessionId: string;
  patchId: string;
  actorId: string;
  type: "replan_proposed" | "replan_failed";
  mode?: ReplanMode;
  reason?: string;
  now: Date;
}): RuntimeEvent {
  const payload =
    input.type === "replan_proposed"
      ? { patchId: input.patchId, mode: input.mode }
      : { patchId: input.patchId, reason: input.reason };
  return runtimeEventSchema.parse({
    id: `${input.sessionId}-${input.type}-${input.patchId}`,
    sessionId: input.sessionId,
    idempotencyKey: `${input.type}:${input.patchId}`,
    actorId: input.actorId,
    origin: "replan",
    type: input.type,
    payload,
    occurredAt: input.now,
  });
}

export class D1ReplanStore {
  constructor(private readonly d1: D1Database) {}

  async getLatest(sessionId: string): Promise<PlanChange | null> {
    const row = await this.d1
      .prepare("SELECT * FROM plan_patches WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
      .bind(sessionId)
      .first<PatchRow>();
    return row ? rowToChange(row) : null;
  }

  async get(sessionId: string, patchId: string): Promise<PlanChange | null> {
    const row = await this.getRow(sessionId, patchId);
    return row ? rowToChange(row) : null;
  }

  async propose(input: {
    sessionId: string;
    actorId: string;
    mode: ReplanMode;
    patch: PlanPatch;
    candidateWorldState: WorldState;
    expectedCauseEventIds: readonly string[];
    expectedAffectedStepIds: readonly string[];
    capabilityPolicies: readonly ReplanCapabilityPolicy[];
    domainVersion: number;
    normalizedInputRevision: number | null;
  }): Promise<ReplanMutationResult> {
    const patch = planPatchSchema.parse(input.patch);
    const state = await this.requireState(input.sessionId);
    const successfulPrior = await this.getSuccessfulByCauseKey(
      input.sessionId,
      causeKey(input.domainVersion, input.normalizedInputRevision, patch.causeEventIds),
    );
    const prior =
      successfulPrior ??
      (await this.getByAttemptKey(
        input.sessionId,
        attemptKey(input.domainVersion, input.normalizedInputRevision, patch),
      ));
    if (prior) {
      return {
        kind: prior.status,
        change: prior,
        state,
        event: await this.getChangeEvent(input.sessionId, prior),
      };
    }
    if (state.session.status === "completed" || state.session.status === "cancelled") {
      throw new Error(`Cannot replan a ${state.session.status} session`);
    }
    const candidateWorldState = worldStateSchema.parse(input.candidateWorldState);
    const sessionDomainVersion = await this.requireSessionDomainVersion(input.sessionId);
    const normalizedInputRevision = await this.currentNormalizedInputRevision(input.sessionId);
    let mode = replanModeSchema.parse(input.mode);
    const currentLastEventId = await currentReplanBaseEventId(this.d1, input.sessionId);
    const { activeStepIds, confirmationRequiredStepIds } = inspectPatchSteps(
      patch,
      state.stepStates,
    );

    let candidate: ExecutionPlan;
    try {
      mode = resolvePlanPatchMode({
        defaultMode: mode,
        patch,
        capabilityPolicies: input.capabilityPolicies,
      });
      if (!sameIdSet(patch.causeEventIds, input.expectedCauseEventIds)) {
        throw new PlanPatchValidationError(
          "Patch cause events differ from the Runtime-approved assessment",
        );
      }
      if (input.domainVersion !== sessionDomainVersion) {
        throw new PlanPatchValidationError(
          "Session Domain version is incompatible with the Replanner",
        );
      }
      if (input.normalizedInputRevision !== normalizedInputRevision) {
        throw new PlanPatchValidationError("Normalized input changed after the Replan assessment");
      }
      assertPatchMatchesApprovedSubgraph(state.plan, patch, input.expectedAffectedStepIds);
      candidate = applyPlanPatch({
        plan: state.plan,
        stepStates: state.stepStates,
        worldState: state.worldState,
        appliedEventIds: state.appliedEventIds,
        currentLastEventId,
        patch,
        phase: "proposal",
        capabilityIds: input.capabilityPolicies.map(({ id }) => id),
      }).plan;
    } catch (caught) {
      const reason = safePatchFailure(caught);
      return this.recordFailure({ ...input, patch, mode, state, reason });
    }

    if (mode === "automatic" && confirmationRequiredStepIds.length === 0) {
      return this.activate({
        ...input,
        patch,
        mode,
        state,
        candidate,
        candidateWorldState,
        confirmedActiveStepIds: [],
        createPatchRow: true,
        domainVersion: input.domainVersion,
        normalizedInputRevision: input.normalizedInputRevision,
        activeStepIdsAtProposal: [],
      });
    }

    const status = mode === "suggest" ? "suggested" : "pending_confirmation";
    const now = new Date();
    const event = auditEvent({
      sessionId: input.sessionId,
      patchId: patch.id,
      actorId: input.actorId,
      type: "replan_proposed",
      mode,
      now,
    });
    const nextState = applyRuntimeEvent(state, event);
    await this.d1.batch([
      insertPatchStatement(this.d1, {
        sessionId: input.sessionId,
        actorId: input.actorId,
        patch,
        mode,
        status,
        candidateWorldState,
        domainVersion: input.domainVersion,
        normalizedInputRevision: input.normalizedInputRevision,
        activeStepIdsAtProposal: activeStepIds,
        now,
      }),
      insertEventStatement(this.d1, event),
      updateMaterializedStatement(this.d1, input.sessionId, nextState, now),
    ]);
    const change = await this.get(input.sessionId, patch.id);
    if (!change) throw new Error(`Failed to read proposed patch ${patch.id}`);
    return { kind: status, change, state: nextState, event };
  }

  async activatePending(input: {
    sessionId: string;
    patchId: string;
    actorId: string;
    humanConfirmed: boolean;
    capabilityPolicies: readonly ReplanCapabilityPolicy[];
    domainVersion: number;
  }): Promise<ReplanMutationResult> {
    const row = await this.getRow(input.sessionId, input.patchId);
    if (!row) throw new Error(`Unknown plan patch: ${input.patchId}`);
    const change = rowToChange(row);
    const candidateWorldState = worldStateSchema.parse(parseJson(row.candidate_world_state_json));
    const state = await this.requireState(input.sessionId);
    if (
      change.status === "applied" ||
      change.status === "failed" ||
      change.status === "suggested"
    ) {
      return {
        kind: change.status,
        change,
        state,
        event: await this.getChangeEvent(input.sessionId, change),
      };
    }
    if (!input.humanConfirmed) throw new Error("Applying a pending patch requires confirmation");
    const sessionDomainVersion = await this.requireSessionDomainVersion(input.sessionId);
    if (
      change.validationDomainVersion !== input.domainVersion ||
      sessionDomainVersion !== input.domainVersion
    ) {
      return this.recordFailure({
        sessionId: input.sessionId,
        actorId: input.actorId,
        patch: change.patch,
        mode: change.mode,
        state,
        reason: "Plan patch Domain version no longer matches the session",
        updateExisting: true,
        activeStepIdsAtProposal: change.activeStepIdsAtProposal,
        domainVersion: change.validationDomainVersion,
        normalizedInputRevision: change.validationNormalizedInputRevision,
      });
    }
    if (
      (await this.currentNormalizedInputRevision(input.sessionId)) !==
      change.validationNormalizedInputRevision
    ) {
      return this.recordFailure({
        sessionId: input.sessionId,
        actorId: input.actorId,
        patch: change.patch,
        mode: change.mode,
        state,
        reason: "Normalized input changed after the Patch was proposed",
        updateExisting: true,
        activeStepIdsAtProposal: change.activeStepIdsAtProposal,
        domainVersion: change.validationDomainVersion,
        normalizedInputRevision: change.validationNormalizedInputRevision,
      });
    }
    let currentLastEventId = await currentReplanBaseEventId(this.d1, input.sessionId);
    if (
      change.activeStepIdsAtProposal.length > 0 &&
      (state.session.status !== "paused" ||
        Object.values(state.timers).some(({ status }) => status === "running") ||
        change.activeStepIdsAtProposal.some(
          (stepId) => state.stepStates[stepId]?.status !== "paused",
        ))
    ) {
      return { kind: "pending_confirmation", change, state, event: null };
    }
    if (
      change.activeStepIdsAtProposal.length > 0 &&
      (await hasOnlyInterruptionEventsSinceBase(
        this.d1,
        input.sessionId,
        change.patch.baseLastEventId,
        change.activeStepIdsAtProposal,
      ))
    ) {
      currentLastEventId = change.patch.baseLastEventId;
    }
    let candidate: ExecutionPlan;
    try {
      candidate = applyPlanPatch({
        plan: state.plan,
        stepStates: state.stepStates,
        worldState: state.worldState,
        appliedEventIds: state.appliedEventIds,
        currentLastEventId,
        patch: change.patch,
        phase: "activation",
        humanConfirmed: input.humanConfirmed,
        capabilityIds: input.capabilityPolicies.map(({ id }) => id),
      }).plan;
    } catch (caught) {
      const reason = safePatchFailure(caught);
      return this.recordFailure({
        sessionId: input.sessionId,
        actorId: input.actorId,
        patch: change.patch,
        mode: change.mode,
        state,
        reason,
        updateExisting: true,
        activeStepIdsAtProposal: change.activeStepIdsAtProposal,
        domainVersion: input.domainVersion,
        normalizedInputRevision: change.validationNormalizedInputRevision,
      });
    }
    return this.activate({
      sessionId: input.sessionId,
      actorId: input.actorId,
      patch: change.patch,
      mode: change.mode,
      state,
      candidate,
      candidateWorldState,
      confirmedActiveStepIds: change.activeStepIdsAtProposal,
      createPatchRow: false,
      domainVersion: input.domainVersion,
      normalizedInputRevision: change.validationNormalizedInputRevision,
      activeStepIdsAtProposal: change.activeStepIdsAtProposal,
    });
  }

  private async activate(input: {
    sessionId: string;
    actorId: string;
    patch: PlanPatch;
    mode: ReplanMode;
    state: MaterializedExecutionState;
    candidate: ExecutionPlan;
    candidateWorldState: WorldState;
    confirmedActiveStepIds: string[];
    createPatchRow: boolean;
    domainVersion: number;
    normalizedInputRevision: number | null;
    activeStepIdsAtProposal: string[];
  }): Promise<ReplanMutationResult> {
    return activatePlanPatch({
      d1: this.d1,
      ...input,
      readChange: (sessionId, patchId) => this.get(sessionId, patchId),
    });
  }

  private async recordFailure(input: {
    sessionId: string;
    actorId: string;
    patch: PlanPatch;
    mode: ReplanMode;
    state: MaterializedExecutionState;
    reason: string;
    updateExisting?: boolean;
    domainVersion: number;
    normalizedInputRevision: number | null;
    activeStepIdsAtProposal?: string[];
  }): Promise<ReplanMutationResult> {
    const now = new Date();
    const event = auditEvent({
      sessionId: input.sessionId,
      patchId: input.patch.id,
      actorId: input.actorId,
      type: "replan_failed",
      reason: input.reason,
      now,
    });
    const nextState = applyRuntimeEvent(input.state, event);
    const patchStatement = input.updateExisting
      ? this.d1
          .prepare(
            "UPDATE plan_patches SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ? AND session_id = ?",
          )
          .bind(input.reason, now.toISOString(), input.patch.id, input.sessionId)
      : insertPatchStatement(this.d1, {
          sessionId: input.sessionId,
          actorId: input.actorId,
          patch: input.patch,
          mode: input.mode,
          status: "failed",
          candidateWorldState: input.state.worldState,
          domainVersion: input.domainVersion,
          normalizedInputRevision: input.normalizedInputRevision,
          activeStepIdsAtProposal: input.activeStepIdsAtProposal ?? [],
          failureReason: input.reason,
          now,
        });
    await this.d1.batch([
      patchStatement,
      insertEventStatement(this.d1, event),
      updateMaterializedStatement(this.d1, input.sessionId, nextState, now),
    ]);
    const change = await this.get(input.sessionId, input.patch.id);
    if (!change) throw new Error(`Failed to read failed patch ${input.patch.id}`);
    return { kind: "failed", change, state: nextState, event };
  }

  private async requireState(sessionId: string): Promise<MaterializedExecutionState> {
    const state = await new D1ExecutionStateRepository(this.d1).get(sessionId);
    if (!state) throw new SessionNotFoundError(sessionId);
    return materializedExecutionStateSchema.parse(state);
  }

  private async requireSessionDomainVersion(sessionId: string): Promise<number> {
    const row = await this.d1
      .prepare("SELECT domain_version FROM execution_sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ domain_version: number }>();
    if (!row) throw new SessionNotFoundError(sessionId);
    return row.domain_version;
  }

  private async currentNormalizedInputRevision(sessionId: string): Promise<number | null> {
    const row = await this.d1
      .prepare("SELECT revision FROM normalized_inputs WHERE session_id = ?")
      .bind(sessionId)
      .first<{ revision: number }>();
    return row?.revision ?? null;
  }

  private async getSuccessfulByCauseKey(
    sessionId: string,
    key: string,
  ): Promise<PlanChange | null> {
    const row = await this.d1
      .prepare(
        `SELECT * FROM plan_patches
         WHERE session_id = ? AND cause_key = ?
           AND status IN ('suggested', 'pending_confirmation', 'applied')
         ORDER BY rowid DESC LIMIT 1`,
      )
      .bind(sessionId, key)
      .first<PatchRow>();
    return row ? rowToChange(row) : null;
  }

  private async getByAttemptKey(sessionId: string, key: string): Promise<PlanChange | null> {
    const row = await this.d1
      .prepare("SELECT * FROM plan_patches WHERE session_id = ? AND attempt_key = ?")
      .bind(sessionId, key)
      .first<PatchRow>();
    return row ? rowToChange(row) : null;
  }

  private async getRow(sessionId: string, patchId: string): Promise<PatchRow | null> {
    return this.d1
      .prepare("SELECT * FROM plan_patches WHERE session_id = ? AND id = ?")
      .bind(sessionId, patchId)
      .first<PatchRow>();
  }

  private async getChangeEvent(
    sessionId: string,
    change: PlanChange,
  ): Promise<RuntimeEvent | null> {
    const idempotencyKey =
      change.status === "applied"
        ? `plan-updated:${change.patch.id}`
        : change.status === "failed"
          ? `replan_failed:${change.patch.id}`
          : `replan_proposed:${change.patch.id}`;
    const row = await this.d1
      .prepare("SELECT event_json FROM runtime_events WHERE session_id = ? AND idempotency_key = ?")
      .bind(sessionId, idempotencyKey)
      .first<{ event_json: string }>();
    return row ? parseRuntimeEvent(row.event_json) : null;
  }
}
