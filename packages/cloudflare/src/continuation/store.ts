import {
  applyRuntimeEvent,
  checkpointPlanVersionId,
  continuationWakeConditionSchema,
  executionContinuationSchema,
  runtimeEventSchema,
  type ContinuationWakeCondition,
  type ExecutionContinuation,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "@pear-agent/core";

import { ContinuationConflictError, SessionNotFoundError } from "../errors.js";
import { D1ExecutionStateRepository } from "../d1/repository.js";
import {
  parseJson,
  serializeExecutionState,
  serializeJson,
  serializeRuntimeEvent,
  serializeRuntimeSnapshot,
} from "../serialize.js";

const ACTIVE_STATUSES = ["suspended", "wake_pending", "resuming"] as const;

export type SuspendContinuationInput = {
  id?: string;
  actorId: string;
  wakeCondition: ContinuationWakeCondition;
  suspendedReason: string;
  resumeDirective: string;
  providerResumeHandle?: string | null;
  now?: Date;
};

export type ContinuationClaimResult =
  | { ok: true; continuation: ExecutionContinuation; snapshot: RuntimeSnapshot }
  | { ok: false; code: "not_found" | "conflict" };

type ContinuationRow = {
  id: string;
  session_id: string;
  status: string;
  wake_condition_json: string;
  suspended_reason: string;
  resume_directive: string;
  checkpoint_plan_version_id: string;
  checkpoint_last_event_id: string | null;
  checkpoint_snapshot_json: string;
  provider_resume_handle: string | null;
  scheduler_id: string | null;
  resuming_actor_id: string | null;
  resume_attempt_id: string | null;
  resume_claimed_at: string | null;
  created_at: string;
  updated_at: string;
};

function rowToContinuation(row: ContinuationRow): ExecutionContinuation {
  return executionContinuationSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    wakeCondition: parseJson(row.wake_condition_json),
    suspendedReason: row.suspended_reason,
    resumeDirective: row.resume_directive,
    checkpointPlanVersionId: row.checkpoint_plan_version_id,
    checkpointLastEventId: row.checkpoint_last_event_id,
    providerResumeHandle: row.provider_resume_handle,
    schedulerId: row.scheduler_id,
    resumingActorId: row.resuming_actor_id,
    resumeAttemptId: row.resume_attempt_id,
    resumeClaimedAt: row.resume_claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function eventFor(
  sessionId: string,
  continuationId: string,
  actorId: string,
  type: Extract<RuntimeEvent["type"], `continuation_${string}`>,
  now: Date,
  attemptId?: string,
): RuntimeEvent {
  const identity = attemptId ? `${type}-${attemptId}` : type;
  return runtimeEventSchema.parse({
    id: `${continuationId}-${identity}`,
    sessionId,
    idempotencyKey: `${continuationId}:${identity}`,
    actorId,
    origin: "continuation",
    type,
    payload: { continuationId },
    occurredAt: now,
  });
}

export class D1ContinuationStore {
  constructor(private readonly d1: D1Database) {}

  async getActive(sessionId: string): Promise<ExecutionContinuation | null> {
    const row = await this.d1
      .prepare(
        `SELECT * FROM execution_continuations
         WHERE session_id = ? AND status IN ('suspended', 'wake_pending', 'resuming')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(sessionId)
      .first<ContinuationRow>();
    return row ? rowToContinuation(row) : null;
  }

  async get(sessionId: string, continuationId: string): Promise<ExecutionContinuation | null> {
    const row = await this.d1
      .prepare("SELECT * FROM execution_continuations WHERE session_id = ? AND id = ?")
      .bind(sessionId, continuationId)
      .first<ContinuationRow>();
    return row ? rowToContinuation(row) : null;
  }

  async suspend(
    sessionId: string,
    input: SuspendContinuationInput,
  ): Promise<ExecutionContinuation> {
    if (await this.getActive(sessionId)) throw new ContinuationConflictError(sessionId);
    const repository = new D1ExecutionStateRepository(this.d1);
    const state = await repository.get(sessionId);
    if (!state) throw new SessionNotFoundError(sessionId);
    const snapshot = await repository.getSnapshot(sessionId);
    if (!snapshot) throw new SessionNotFoundError(sessionId);

    const now = input.now ?? new Date();
    const id = input.id ?? crypto.randomUUID();
    const wakeCondition = continuationWakeConditionSchema.parse(input.wakeCondition);
    const last = snapshot.recentEvents[snapshot.recentEvents.length - 1];
    const continuation = executionContinuationSchema.parse({
      id,
      sessionId,
      status: "suspended",
      wakeCondition,
      suspendedReason: input.suspendedReason,
      resumeDirective: input.resumeDirective,
      checkpointPlanVersionId: checkpointPlanVersionId(snapshot.plan.id, snapshot.plan.version),
      checkpointLastEventId: last?.id ?? null,
      providerResumeHandle: input.providerResumeHandle ?? null,
      schedulerId: null,
      resumingActorId: null,
      resumeAttemptId: null,
      resumeClaimedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const event = eventFor(sessionId, id, input.actorId, "continuation_suspended", now);
    const next = applyRuntimeEvent(state, event);

    await this.d1.batch([
      this.d1
        .prepare(
          `INSERT INTO execution_continuations
           (id, session_id, status, wake_condition_json, suspended_reason, resume_directive,
            checkpoint_plan_version_id, checkpoint_last_event_id, checkpoint_snapshot_json,
            provider_resume_handle, scheduler_id, resuming_actor_id, resume_attempt_id,
            resume_claimed_at, transition_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          sessionId,
          continuation.status,
          serializeJson(wakeCondition),
          continuation.suspendedReason,
          continuation.resumeDirective,
          continuation.checkpointPlanVersionId,
          continuation.checkpointLastEventId,
          serializeRuntimeSnapshot(snapshot),
          continuation.providerResumeHandle,
          null,
          null,
          null,
          null,
          null,
          now.toISOString(),
          now.toISOString(),
        ),
      this.d1
        .prepare(
          "INSERT INTO runtime_events (id, session_id, idempotency_key, event_json, occurred_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          event.id,
          sessionId,
          event.idempotencyKey,
          serializeRuntimeEvent(event),
          now.toISOString(),
        ),
      this.d1
        .prepare(
          "UPDATE materialized_states SET state_json = ?, updated_at = ? WHERE session_id = ?",
        )
        .bind(serializeExecutionState(next), now.toISOString(), sessionId),
      this.d1
        .prepare("UPDATE execution_sessions SET updated_at = ? WHERE id = ?")
        .bind(now.toISOString(), sessionId),
    ]);
    return continuation;
  }

  async setSchedulerId(id: string, schedulerId: string): Promise<void> {
    await this.d1
      .prepare("UPDATE execution_continuations SET scheduler_id = ?, updated_at = ? WHERE id = ?")
      .bind(schedulerId, new Date().toISOString(), id)
      .run();
  }

  async wake(
    sessionId: string,
    continuationId: string,
    actorId = "system",
  ): Promise<ExecutionContinuation | null> {
    return this.transitionWithEvent(
      sessionId,
      continuationId,
      ["suspended"],
      "wake_pending",
      "continuation_wake_pending",
      actorId,
    );
  }

  async wakeForEvent(event: RuntimeEvent): Promise<ExecutionContinuation | null> {
    const active = await this.getActive(event.sessionId);
    if (
      !active ||
      active.status !== "suspended" ||
      active.wakeCondition.type !== "event" ||
      active.wakeCondition.eventType !== event.type
    ) {
      return null;
    }
    const ordering = await this.d1
      .prepare(
        `SELECT current_event.rowid AS event_rowid, checkpoint.rowid AS checkpoint_rowid
         FROM runtime_events AS current_event
         LEFT JOIN runtime_events AS checkpoint
           ON checkpoint.session_id = current_event.session_id AND checkpoint.id = ?
         WHERE current_event.session_id = ? AND current_event.id = ?`,
      )
      .bind(active.checkpointLastEventId, event.sessionId, event.id)
      .first<{ event_rowid: number; checkpoint_rowid: number | null }>();
    if (
      !ordering ||
      (active.checkpointLastEventId !== null &&
        (ordering.checkpoint_rowid === null || ordering.event_rowid <= ordering.checkpoint_rowid))
    ) {
      return null;
    }
    return this.wake(event.sessionId, active.id);
  }

  async claimResume(
    sessionId: string,
    continuationId: string,
    actorId: string,
  ): Promise<ContinuationClaimResult> {
    const current = await this.get(sessionId, continuationId);
    if (!current) return { ok: false, code: "not_found" };
    const attemptId = crypto.randomUUID();
    const claimedAt = new Date();
    const next = await this.transitionWithEvent(
      sessionId,
      continuationId,
      ["suspended", "wake_pending"],
      "resuming",
      "continuation_resuming",
      actorId,
      { attemptId, resumingActorId: actorId, resumeClaimedAt: claimedAt },
    );
    if (!next) return { ok: false, code: "conflict" };
    const repository = new D1ExecutionStateRepository(this.d1);
    const snapshot = await repository.getSnapshot(sessionId);
    if (!snapshot) throw new SessionNotFoundError(sessionId);
    return {
      ok: true,
      continuation: next,
      snapshot: { ...snapshot, continuation: next },
    };
  }

  async complete(
    sessionId: string,
    continuationId: string,
    actorId: string,
    attemptId: string,
  ): Promise<ExecutionContinuation | null> {
    const current = await this.get(sessionId, continuationId);
    if (!current || current.resumingActorId !== actorId || current.resumeAttemptId !== attemptId) {
      return null;
    }
    return this.transitionWithEvent(
      sessionId,
      continuationId,
      ["resuming"],
      "completed",
      "continuation_completed",
      actorId,
      { attemptId },
    );
  }

  async failResume(
    sessionId: string,
    continuationId: string,
    actorId: string,
    attemptId: string,
  ): Promise<ExecutionContinuation | null> {
    const current = await this.get(sessionId, continuationId);
    if (
      !current ||
      current.resumeAttemptId !== attemptId ||
      (actorId !== "system" && current.resumingActorId !== actorId)
    ) {
      return null;
    }
    return this.transitionWithEvent(
      sessionId,
      continuationId,
      ["resuming"],
      "wake_pending",
      "continuation_resume_failed",
      actorId,
      { attemptId },
    );
  }

  async expire(sessionId: string, continuationId: string): Promise<ExecutionContinuation | null> {
    return this.transitionWithEvent(
      sessionId,
      continuationId,
      [...ACTIVE_STATUSES],
      "expired",
      "continuation_expired",
      "system",
    );
  }

  private async transitionWithEvent(
    sessionId: string,
    continuationId: string,
    from: readonly string[],
    to: ExecutionContinuation["status"],
    eventType: Extract<RuntimeEvent["type"], `continuation_${string}`>,
    actorId: string,
    attempt?: {
      attemptId: string;
      resumingActorId?: string;
      resumeClaimedAt?: Date;
    },
  ): Promise<ExecutionContinuation | null> {
    const current = await this.get(sessionId, continuationId);
    if (!current || !from.includes(current.status)) return null;
    const repository = new D1ExecutionStateRepository(this.d1);
    const state = await repository.get(sessionId);
    if (!state) throw new SessionNotFoundError(sessionId);
    const now = new Date();
    const event = eventFor(sessionId, continuationId, actorId, eventType, now, attempt?.attemptId);
    const nextState = applyRuntimeEvent(state, event);
    const placeholders = from.map(() => "?").join(", ");
    const transitionToken = crypto.randomUUID();
    const resumingActorId = attempt?.resumingActorId ?? null;
    const resumeAttemptId = attempt?.resumingActorId ? attempt.attemptId : null;
    const resumeClaimedAt = attempt?.resumeClaimedAt?.toISOString() ?? null;
    const results = await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE execution_continuations
           SET status = ?, updated_at = ?, resuming_actor_id = ?, resume_attempt_id = ?,
               resume_claimed_at = ?, transition_token = ?
           WHERE id = ? AND session_id = ? AND status IN (${placeholders})`,
        )
        .bind(
          to,
          now.toISOString(),
          resumingActorId,
          resumeAttemptId,
          resumeClaimedAt,
          transitionToken,
          continuationId,
          sessionId,
          ...from,
        ),
      this.d1
        .prepare(
          `INSERT INTO runtime_events (id, session_id, idempotency_key, event_json, occurred_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM execution_continuations WHERE id = ? AND transition_token = ?
           )`,
        )
        .bind(
          event.id,
          sessionId,
          event.idempotencyKey,
          serializeRuntimeEvent(event),
          now.toISOString(),
          continuationId,
          transitionToken,
        ),
      this.d1
        .prepare(
          `UPDATE materialized_states SET state_json = ?, updated_at = ?
           WHERE session_id = ? AND EXISTS (
             SELECT 1 FROM execution_continuations WHERE id = ? AND transition_token = ?
           )`,
        )
        .bind(
          serializeExecutionState(nextState),
          now.toISOString(),
          sessionId,
          continuationId,
          transitionToken,
        ),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) return null;
    return this.get(sessionId, continuationId);
  }
}
