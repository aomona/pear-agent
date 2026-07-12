import {
  applyPlanPatch,
  applyRuntimeEvent,
  findActivePatchStepIds,
  findConfirmationRequiredPatchStepIds,
  materializedExecutionStateSchema,
  planChangeSchema,
  PlanPatchValidationError,
  planPatchSchema,
  replanModeSchema,
  resolvePlanPatchMode,
  runtimeEventSchema,
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
import {
  parseJson,
  serializeExecutionState,
  serializeJson,
  serializeRuntimeEvent,
  parseRuntimeEvent,
} from "../serialize.js";

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

function causeKey(
  domainVersion: number,
  normalizedInputRevision: number | null,
  eventIds: readonly string[],
): string {
  return JSON.stringify([domainVersion, normalizedInputRevision, [...new Set(eventIds)].sort()]);
}

function attemptKey(
  domainVersion: number,
  normalizedInputRevision: number | null,
  patch: PlanPatch,
): string {
  return JSON.stringify([
    causeKey(domainVersion, normalizedInputRevision, patch.causeEventIds),
    patch.basePlanId,
    patch.basePlanVersion,
    patch.baseLastEventId,
  ]);
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const expected = new Set(right);
  return left.length === expected.size && left.every((id) => expected.has(id));
}

function safePatchFailure(caught: unknown): string {
  return caught instanceof PlanPatchValidationError
    ? caught.message.slice(0, 2_000)
    : "Plan patch validation failed";
}

const NORMALIZED_INPUT_REVISION_GATE = `(
  (? IS NULL AND NOT EXISTS (
    SELECT 1 FROM normalized_inputs absent_input WHERE absent_input.session_id = es.id
  )) OR EXISTS (
    SELECT 1 FROM normalized_inputs current_input
    WHERE current_input.session_id = es.id AND current_input.revision = ?
  )
)`;

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
    const currentLastEventId = await this.currentReplanBaseEventId(input.sessionId);
    const activeStepIds = findActivePatchStepIds(patch, state.stepStates);
    const confirmationRequiredStepIds = findConfirmationRequiredPatchStepIds(
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
      const expectedAffected = new Set(input.expectedAffectedStepIds);
      const knownStepIds = new Set(state.plan.steps.map(({ id }) => id));
      const addedStepIds = patch.operations
        .filter((operation) => operation.type === "add_step")
        .map((operation) => operation.step.id);
      const existingAffected = patch.affectedStepIds.filter((stepId) => knownStepIds.has(stepId));
      const newAffected = patch.affectedStepIds.filter((stepId) => !knownStepIds.has(stepId));
      if (
        existingAffected.length !== expectedAffected.size ||
        existingAffected.some((stepId) => !expectedAffected.has(stepId)) ||
        newAffected.length !== new Set(addedStepIds).size ||
        newAffected.some((stepId) => !addedStepIds.includes(stepId))
      ) {
        throw new PlanPatchValidationError(
          "Patch affected steps differ from the Runtime-approved subgraph",
        );
      }
      candidate = applyPlanPatch({
        plan: state.plan,
        stepStates: state.stepStates,
        worldState: state.worldState,
        appliedEventIds: state.appliedEventIds,
        patch,
        // Proposal validation may inspect an active-step candidate. Actual
        // activation still requires the real session to be paused + confirmed.
        activeStepChangeConfirmed: confirmationRequiredStepIds.length > 0,
        allowActiveStepProposal: activeStepIds.length > 0,
        capabilityIds: input.capabilityPolicies.map(({ id }) => id),
        currentLastEventId,
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
      this.insertPatchStatement({
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
      this.insertEventStatement(event),
      this.updateMaterializedStatement(input.sessionId, nextState, now),
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
    let currentLastEventId = await this.currentReplanBaseEventId(input.sessionId);
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
      (await this.hasOnlyInterruptionEventsSinceBase(
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
        patch: change.patch,
        activeStepChangeConfirmed: input.humanConfirmed,
        capabilityIds: input.capabilityPolicies.map(({ id }) => id),
        currentLastEventId,
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
    const now = new Date();
    const transitionToken = crypto.randomUUID();
    const event = runtimeEventSchema.parse({
      id: `${input.sessionId}-plan-updated-${input.patch.id}`,
      sessionId: input.sessionId,
      idempotencyKey: `plan-updated:${input.patch.id}`,
      actorId: input.actorId,
      origin: "replan",
      type: "plan_updated",
      payload: {
        plan: input.candidate,
        worldState: { ...input.candidateWorldState, updatedAt: now },
        patchId: input.patch.id,
        summary: input.patch.summary,
        confirmedActiveStepIds: input.confirmedActiveStepIds,
      },
      occurredAt: now,
    });
    const nextState = applyRuntimeEvent(input.state, event);
    const statements: D1PreparedStatement[] = [];
    if (input.createPatchRow) {
      statements.push(
        this.insertPatchStatement({
          sessionId: input.sessionId,
          actorId: input.actorId,
          patch: input.patch,
          mode: input.mode,
          status: "applied",
          candidateWorldState: input.candidateWorldState,
          domainVersion: input.domainVersion,
          normalizedInputRevision: input.normalizedInputRevision,
          activeStepIdsAtProposal: input.activeStepIdsAtProposal,
          targetPlanVersion: input.candidate.version,
          transitionToken,
          requireBasePlanVersion: true,
          now,
        }),
      );
    } else {
      statements.push(
        this.d1
          .prepare(
            `UPDATE plan_patches
             SET status = 'applied', target_plan_version = ?, failure_reason = NULL,
                 transition_token = ?, updated_at = ?
             WHERE id = ? AND session_id = ? AND status = 'pending_confirmation'
               AND EXISTS (
                 SELECT 1 FROM execution_sessions es
                 WHERE es.id = ? AND es.plan_version = ? AND es.domain_version = ?
                   AND ${NORMALIZED_INPUT_REVISION_GATE}
               )`,
          )
          .bind(
            input.candidate.version,
            transitionToken,
            now.toISOString(),
            input.patch.id,
            input.sessionId,
            input.sessionId,
            input.patch.basePlanVersion,
            input.domainVersion,
            input.normalizedInputRevision,
            input.normalizedInputRevision,
          ),
      );
    }
    const gate = `EXISTS (
      SELECT 1 FROM plan_patches pp
      JOIN execution_sessions es ON es.id = pp.session_id
      WHERE pp.id = ? AND pp.session_id = ? AND pp.transition_token = ?
        AND es.plan_version = ? AND es.domain_version = ?
        AND ${NORMALIZED_INPUT_REVISION_GATE}
    )`;
    statements.push(
      this.d1
        .prepare(
          `UPDATE plan_versions SET status = 'superseded'
           WHERE session_id = ? AND status = 'active' AND ${gate}`,
        )
        .bind(
          input.sessionId,
          input.patch.id,
          input.sessionId,
          transitionToken,
          input.patch.basePlanVersion,
          input.domainVersion,
          input.normalizedInputRevision,
          input.normalizedInputRevision,
        ),
      this.d1
        .prepare(
          `INSERT INTO plan_versions (session_id, version, plan_json, patch_id, status, created_at)
           SELECT ?, ?, ?, ?, 'active', ? WHERE ${gate}`,
        )
        .bind(
          input.sessionId,
          input.candidate.version,
          serializeJson(input.candidate),
          input.patch.id,
          now.toISOString(),
          input.patch.id,
          input.sessionId,
          transitionToken,
          input.patch.basePlanVersion,
          input.domainVersion,
          input.normalizedInputRevision,
          input.normalizedInputRevision,
        ),
      this.d1
        .prepare(
          `INSERT INTO runtime_events (id, session_id, idempotency_key, event_json, occurred_at)
           SELECT ?, ?, ?, ?, ? WHERE ${gate}`,
        )
        .bind(
          event.id,
          event.sessionId,
          event.idempotencyKey,
          serializeRuntimeEvent(event),
          event.occurredAt.toISOString(),
          input.patch.id,
          input.sessionId,
          transitionToken,
          input.patch.basePlanVersion,
          input.domainVersion,
          input.normalizedInputRevision,
          input.normalizedInputRevision,
        ),
      this.d1
        .prepare(
          `UPDATE materialized_states SET state_json = ?, updated_at = ?
           WHERE session_id = ? AND ${gate}`,
        )
        .bind(
          serializeExecutionState(nextState),
          now.toISOString(),
          input.sessionId,
          input.patch.id,
          input.sessionId,
          transitionToken,
          input.patch.basePlanVersion,
          input.domainVersion,
          input.normalizedInputRevision,
          input.normalizedInputRevision,
        ),
      this.d1
        .prepare(
          `UPDATE execution_sessions
           SET plan_id = ?, plan_version = ?, goal_id = ?, status = ?, updated_at = ?
           WHERE id = ? AND plan_version = ? AND domain_version = ? AND ${gate}`,
        )
        .bind(
          nextState.session.planId,
          nextState.session.planVersion,
          nextState.session.goalId,
          nextState.session.status,
          now.toISOString(),
          input.sessionId,
          input.patch.basePlanVersion,
          input.domainVersion,
          input.patch.id,
          input.sessionId,
          transitionToken,
          input.patch.basePlanVersion,
          input.domainVersion,
          input.normalizedInputRevision,
          input.normalizedInputRevision,
        ),
    );
    const results = await this.d1.batch(statements);
    if ((results.at(-1)?.meta.changes ?? 0) === 0) {
      throw new Error("Plan patch activation lost its base-version compare-and-swap");
    }
    const change = await this.get(input.sessionId, input.patch.id);
    if (!change) throw new Error(`Failed to read applied patch ${input.patch.id}`);
    return { kind: "applied", change, state: nextState, event };
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
      : this.insertPatchStatement({
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
      this.insertEventStatement(event),
      this.updateMaterializedStatement(input.sessionId, nextState, now),
    ]);
    const change = await this.get(input.sessionId, input.patch.id);
    if (!change) throw new Error(`Failed to read failed patch ${input.patch.id}`);
    return { kind: "failed", change, state: nextState, event };
  }

  private insertPatchStatement(input: {
    sessionId: string;
    actorId: string;
    patch: PlanPatch;
    mode: ReplanMode;
    status: PlanChange["status"];
    candidateWorldState: WorldState;
    domainVersion: number;
    normalizedInputRevision: number | null;
    activeStepIdsAtProposal: string[];
    targetPlanVersion?: number;
    failureReason?: string;
    transitionToken?: string;
    requireBasePlanVersion?: boolean;
    now: Date;
  }): D1PreparedStatement {
    const columns = `INSERT INTO plan_patches
         (id, session_id, base_plan_version, cause_key, attempt_key, validation_domain_version,
          normalized_input_revision, target_plan_version,
          mode, status, patch_json, candidate_world_state_json, failure_reason, active_step_ids_json,
          transition_token, created_by_actor_id, created_at, updated_at)`;
    const values = [
      input.patch.id,
      input.sessionId,
      input.patch.basePlanVersion,
      causeKey(input.domainVersion, input.normalizedInputRevision, input.patch.causeEventIds),
      attemptKey(input.domainVersion, input.normalizedInputRevision, input.patch),
      input.domainVersion,
      input.normalizedInputRevision,
      input.targetPlanVersion ?? null,
      input.mode,
      input.status,
      serializeJson(input.patch),
      serializeJson(input.candidateWorldState),
      input.failureReason ?? null,
      serializeJson(input.activeStepIdsAtProposal),
      input.transitionToken ?? null,
      input.actorId,
      input.now.toISOString(),
      input.now.toISOString(),
    ];
    if (input.requireBasePlanVersion) {
      return this.d1
        .prepare(
          `${columns}
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM execution_sessions es
             WHERE es.id = ? AND es.plan_version = ? AND es.domain_version = ?
               AND ${NORMALIZED_INPUT_REVISION_GATE}
           )`,
        )
        .bind(
          ...values,
          input.sessionId,
          input.patch.basePlanVersion,
          input.domainVersion,
          input.normalizedInputRevision,
          input.normalizedInputRevision,
        );
    }
    return this.d1
      .prepare(`${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(...values);
  }

  private insertEventStatement(event: RuntimeEvent): D1PreparedStatement {
    return this.d1
      .prepare(
        "INSERT INTO runtime_events (id, session_id, idempotency_key, event_json, occurred_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        event.id,
        event.sessionId,
        event.idempotencyKey,
        serializeRuntimeEvent(event),
        event.occurredAt.toISOString(),
      );
  }

  private updateMaterializedStatement(
    sessionId: string,
    state: MaterializedExecutionState,
    now: Date,
  ): D1PreparedStatement {
    return this.d1
      .prepare("UPDATE materialized_states SET state_json = ?, updated_at = ? WHERE session_id = ?")
      .bind(serializeExecutionState(state), now.toISOString(), sessionId);
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

  private async currentReplanBaseEventId(sessionId: string): Promise<string | null> {
    const row = await this.d1
      .prepare(
        `SELECT id FROM runtime_events
         WHERE session_id = ?
           AND json_extract(event_json, '$.type') NOT IN ('replan_proposed', 'replan_failed', 'plan_updated')
           AND json_extract(event_json, '$.type') NOT LIKE 'continuation_%'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .bind(sessionId)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  private async hasOnlyInterruptionEventsSinceBase(
    sessionId: string,
    baseEventId: string | null,
    activeStepIds: readonly string[],
  ): Promise<boolean> {
    const rows = await this.d1
      .prepare("SELECT id, event_json FROM runtime_events WHERE session_id = ? ORDER BY rowid ASC")
      .bind(sessionId)
      .all<{ id: string; event_json: string }>();
    const events = rows.results;
    const baseIndex = baseEventId === null ? -1 : events.findIndex(({ id }) => id === baseEventId);
    if (baseEventId !== null && baseIndex < 0) return false;
    const allowedSteps = new Set(activeStepIds);
    return events.slice(baseIndex + 1).every(({ event_json: eventJson }) => {
      const event = parseRuntimeEvent(eventJson);
      if (event.type === "replan_proposed" || event.type === "replan_failed") return true;
      if (event.type.startsWith("continuation_")) return true;
      if (event.type === "session_paused") return true;
      if (event.type === "timer_paused" || event.type === "timer_cancelled") return true;
      return event.type === "step_paused" && allowedSteps.has(event.payload.stepId);
    });
  }
}
