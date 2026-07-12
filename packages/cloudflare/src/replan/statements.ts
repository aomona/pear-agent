import type { PlanChange, PlanPatch, ReplanMode, RuntimeEvent, WorldState } from "@pear-agent/core";
import type { MaterializedExecutionState } from "@pear-agent/core";

import { serializeExecutionState, serializeJson, serializeRuntimeEvent } from "../serialize.js";
import { attemptKey, causeKey } from "./keys.js";

/** SQL fragment: bind normalizedInputRevision twice (NULL-absent path and revision match). */
export const NORMALIZED_INPUT_REVISION_GATE = `(
  (? IS NULL AND NOT EXISTS (
    SELECT 1 FROM normalized_inputs absent_input WHERE absent_input.session_id = es.id
  )) OR EXISTS (
    SELECT 1 FROM normalized_inputs current_input
    WHERE current_input.session_id = es.id AND current_input.revision = ?
  )
)`;

export type ActivationGate = {
  patchId: string;
  sessionId: string;
  transitionToken: string;
  basePlanVersion: number;
  domainVersion: number;
  normalizedInputRevision: number | null;
};

/** EXISTS gate used by activation CAS statements after the transition token is set. */
export function activationGateSql(): string {
  return `EXISTS (
      SELECT 1 FROM plan_patches pp
      JOIN execution_sessions es ON es.id = pp.session_id
      WHERE pp.id = ? AND pp.session_id = ? AND pp.transition_token = ?
        AND es.plan_version = ? AND es.domain_version = ?
        AND ${NORMALIZED_INPUT_REVISION_GATE}
    )`;
}

export function activationGateBinds(gate: ActivationGate): unknown[] {
  return [
    gate.patchId,
    gate.sessionId,
    gate.transitionToken,
    gate.basePlanVersion,
    gate.domainVersion,
    gate.normalizedInputRevision,
    gate.normalizedInputRevision,
  ];
}

export function insertPatchStatement(
  d1: D1Database,
  input: {
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
  },
): D1PreparedStatement {
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
    return d1
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
  return d1
    .prepare(`${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(...values);
}

export function insertEventStatement(d1: D1Database, event: RuntimeEvent): D1PreparedStatement {
  return d1
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

export function updateMaterializedStatement(
  d1: D1Database,
  sessionId: string,
  state: MaterializedExecutionState,
  now: Date,
): D1PreparedStatement {
  return d1
    .prepare("UPDATE materialized_states SET state_json = ?, updated_at = ? WHERE session_id = ?")
    .bind(serializeExecutionState(state), now.toISOString(), sessionId);
}
