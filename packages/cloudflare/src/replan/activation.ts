import {
  applyRuntimeEvent,
  runtimeEventSchema,
  type ExecutionPlan,
  type MaterializedExecutionState,
  type PlanChange,
  type PlanPatch,
  type ReplanMode,
  type RuntimeEvent,
  type WorldState,
} from "@pear-agent/core";

import { serializeExecutionState, serializeJson, serializeRuntimeEvent } from "../serialize.js";
import {
  activationGateBinds,
  activationGateSql,
  insertPatchStatement,
  NORMALIZED_INPUT_REVISION_GATE,
  type ActivationGate,
} from "./statements.js";

export type ActivatePlanPatchInput = {
  d1: D1Database;
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
  /** Load applied PlanChange after the batch succeeds. */
  readChange: (sessionId: string, patchId: string) => Promise<PlanChange | null>;
};

export type ActivatePlanPatchResult = {
  kind: "applied";
  change: PlanChange;
  state: MaterializedExecutionState;
  event: RuntimeEvent;
};

export async function activatePlanPatch(
  input: ActivatePlanPatchInput,
): Promise<ActivatePlanPatchResult> {
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
  const gate: ActivationGate = {
    patchId: input.patch.id,
    sessionId: input.sessionId,
    transitionToken,
    basePlanVersion: input.patch.basePlanVersion,
    domainVersion: input.domainVersion,
    normalizedInputRevision: input.normalizedInputRevision,
  };
  const gateSql = activationGateSql();
  const gateBinds = activationGateBinds(gate);

  const statements: D1PreparedStatement[] = [];
  if (input.createPatchRow) {
    statements.push(
      insertPatchStatement(input.d1, {
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
      input.d1
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

  statements.push(
    input.d1
      .prepare(
        `UPDATE plan_versions SET status = 'superseded'
           WHERE session_id = ? AND status = 'active' AND ${gateSql}`,
      )
      .bind(input.sessionId, ...gateBinds),
    input.d1
      .prepare(
        `INSERT INTO plan_versions (session_id, version, plan_json, patch_id, status, created_at)
           SELECT ?, ?, ?, ?, 'active', ? WHERE ${gateSql}`,
      )
      .bind(
        input.sessionId,
        input.candidate.version,
        serializeJson(input.candidate),
        input.patch.id,
        now.toISOString(),
        ...gateBinds,
      ),
    input.d1
      .prepare(
        `INSERT INTO runtime_events (id, session_id, idempotency_key, event_json, occurred_at)
           SELECT ?, ?, ?, ?, ? WHERE ${gateSql}`,
      )
      .bind(
        event.id,
        event.sessionId,
        event.idempotencyKey,
        serializeRuntimeEvent(event),
        event.occurredAt.toISOString(),
        ...gateBinds,
      ),
    input.d1
      .prepare(
        `UPDATE materialized_states SET state_json = ?, updated_at = ?
           WHERE session_id = ? AND ${gateSql}`,
      )
      .bind(serializeExecutionState(nextState), now.toISOString(), input.sessionId, ...gateBinds),
    input.d1
      .prepare(
        `UPDATE execution_sessions
           SET plan_id = ?, plan_version = ?, goal_id = ?, status = ?, updated_at = ?
           WHERE id = ? AND plan_version = ? AND domain_version = ? AND ${gateSql}`,
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
        ...gateBinds,
      ),
  );

  const results = await input.d1.batch(statements);
  if ((results.at(-1)?.meta.changes ?? 0) === 0) {
    throw new Error("Plan patch activation lost its base-version compare-and-swap");
  }
  const change = await input.readChange(input.sessionId, input.patch.id);
  if (!change) throw new Error(`Failed to read applied patch ${input.patch.id}`);
  return { kind: "applied", change, state: nextState, event };
}
