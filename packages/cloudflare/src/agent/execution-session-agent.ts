import {
  runtimeEventSchema,
  type AppendEventResult,
  type GetSnapshotOptions,
  type MaterializedExecutionState,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type VoiceLease,
  type ContinuationWakeCondition,
  type ExecutionContinuation,
  type PlanChange,
  type PlanPatch,
  type ReplanCapabilityPolicy,
  type ReplanMode,
  type WorldState,
} from "@pear-agent/core";
import { Agent, type Connection, type ConnectionContext } from "agents";

import { D1ExecutionStateRepository } from "../d1/repository.js";
import type { PearEnv } from "../env.js";
import { parseRuntimeEvent } from "../serialize.js";
import { createVoiceLeaseStore } from "../voice/lease-store.js";
import { D1ContinuationStore, type ContinuationClaimResult } from "../continuation/store.js";
import type { VoiceLeaseResult } from "../voice/results.js";
import { EMPTY_SYNC_STATE, type ExecutionSessionSyncState } from "./sync-state.js";
import { D1ReplanStore, type ReplanMutationResult } from "../replan/store.js";

const RESUME_CLAIM_TIMEOUT_SECONDS = 120;

/**
 * Per-session Durable Agent. Serializes mutations for one Execution Session
 * while D1 remains the durable source of truth for state and the event log.
 *
 * DO name is the session id. Methods use typed DO RPC (structured values);
 * JSON string boundaries live only at D1 text columns.
 *
 * Mutations share an in-isolate write queue so concurrent RPC cannot interleave
 * D1 read-modify-write (lost step updates). DO input gates help, but miniflare
 * and concurrent Worker→DO RPC still need an explicit chain.
 *
 * {@link ExecutionSessionSyncState} is a lightweight invalidation pulse for
 * WebSocket clients (`agents/client` / `agents/react`). Clients re-fetch the
 * Runtime Snapshot over HTTP when `revision` advances. It is not the durable
 * PEAR store. WebSocket auth is enforced in {@link createPearWorker}
 * `onBeforeConnect`.
 */
export class ExecutionSessionAgent extends Agent<PearEnv, ExecutionSessionSyncState> {
  override initialState: ExecutionSessionSyncState = EMPTY_SYNC_STATE;

  /**
   * UI clients only subscribe; mutations go through authorized HTTP + DO RPC.
   * Marking WS connections readonly prevents client-originated `setState`.
   */
  override shouldConnectionBeReadonly(_connection: Connection, _ctx: ConnectionContext): boolean {
    return true;
  }

  /**
   * On (re)connect, ensure a non-empty pulse exists when the session is already
   * in D1 but Agent SQLite still holds the empty initial state (cold DO).
   * Skips work when revision is already advanced.
   */
  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    void connection;
    void ctx;
    await this.runExclusive(() => this.ensureSyncPulse());
  }

  /** Chains session mutations so only one D1 RMW runs at a time in this isolate. */
  private writeChain: Promise<void> = Promise.resolve();

  private repository(): D1ExecutionStateRepository {
    return new D1ExecutionStateRepository(this.env.DB);
  }

  /**
   * Run `fn` after prior mutations finish. Failures do not block later writers.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Creates the session in D1 (and optional initial normalized input) in one batch.
   * Agent name must equal `state.session.id`.
   */
  async createSession(input: {
    initialState: MaterializedExecutionState;
    domainId: string;
    domainVersion: number;
    normalizedInput?: unknown;
  }): Promise<{ ok: true }> {
    const sessionId = this.sessionId();
    if (input.initialState.session.id !== sessionId) {
      throw new Error(
        `Session id ${input.initialState.session.id} does not match agent name ${sessionId}`,
      );
    }

    return this.runExclusive(async () => {
      await this.repository().createWithDomain(input.initialState, {
        domainId: input.domainId,
        domainVersion: input.domainVersion,
        ...(input.normalizedInput === undefined ? {} : { normalizedInput: input.normalizedInput }),
      });
      this.bumpPulse(null);
      return { ok: true as const };
    });
  }

  async getState(): Promise<MaterializedExecutionState | null> {
    // Wait for in-flight writes so concurrent readers never observe a partial RMW.
    return this.runExclusive(async () => {
      const state = await this.repository().get(this.sessionId());
      return state ?? null;
    });
  }

  async appendEvent(event: RuntimeEvent): Promise<AppendEventResult> {
    this.assertSession(event.sessionId);
    if (
      event.type === "plan_updated" ||
      event.type === "replan_proposed" ||
      event.type === "replan_failed"
    ) {
      throw new Error(`${event.type} is Runtime-managed and cannot be appended directly`);
    }
    return this.runExclusive(() => this.appendAndPublishEvent(event));
  }

  /** Runtime-owned audit path that cannot mutate the active Plan. */
  async appendReplanFailure(input: {
    actorId: string;
    attemptId: string;
    reason: string;
  }): Promise<AppendEventResult> {
    return this.runExclusive(() =>
      this.appendAndPublishEvent(
        runtimeEventSchema.parse({
          id: `${this.sessionId()}-replan-failed-${input.attemptId}`,
          sessionId: this.sessionId(),
          idempotencyKey: `replan-failed:${input.attemptId}`,
          actorId: input.actorId,
          origin: "replan",
          type: "replan_failed",
          payload: { attemptId: input.attemptId, reason: input.reason.slice(0, 2_000) },
          occurredAt: new Date(),
        }),
      ),
    );
  }

  async getSnapshot(options?: GetSnapshotOptions): Promise<RuntimeSnapshot | null> {
    return this.runExclusive(async () => {
      const snapshot = await this.repository().getSnapshot(this.sessionId(), options);
      if (!snapshot) return null;
      const continuation = await new D1ContinuationStore(this.env.DB).getActive(this.sessionId());
      const latestPlanChange = await new D1ReplanStore(this.env.DB).getLatest(this.sessionId());
      return { ...snapshot, continuation, latestPlanChange };
    });
  }

  async putNormalizedInput(payload: unknown): Promise<{ ok: true }> {
    return this.runExclusive(async () => {
      await this.repository().putNormalizedInput(this.sessionId(), payload);
      // Normalized input is not on the snapshot; still bump so clients re-fetch.
      const previous = this.state ?? EMPTY_SYNC_STATE;
      this.bumpPulse(previous.lastEventId);
      return { ok: true as const };
    });
  }

  async getNormalizedInput(): Promise<unknown | null> {
    return this.runExclusive(async () => {
      const payload = await this.repository().getNormalizedInput(this.sessionId());
      return payload === undefined ? null : payload;
    });
  }

  async getNormalizedInputRecord(): Promise<{
    payload: unknown;
    revision: number;
  } | null> {
    return this.runExclusive(async () => {
      const record = await this.repository().getNormalizedInputRecord(this.sessionId());
      return record ?? null;
    });
  }

  /** Current invalidation pulse (for tests and diagnostics). */
  async getSyncState(): Promise<ExecutionSessionSyncState> {
    return this.state;
  }

  async acquireVoiceLease(input: {
    actorId: string;
    leaseId?: string;
    ttlMs?: number;
  }): Promise<VoiceLeaseResult> {
    return this.runExclusive(async () => {
      const store = createVoiceLeaseStore(this.env.DB);
      return store.acquire({
        sessionId: this.sessionId(),
        actorId: input.actorId,
        ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      });
    });
  }

  async releaseVoiceLease(input: { actorId: string }): Promise<VoiceLeaseResult> {
    return this.runExclusive(async () => {
      const store = createVoiceLeaseStore(this.env.DB);
      return store.release(this.sessionId(), input.actorId);
    });
  }

  async getVoiceLease(): Promise<VoiceLease | null> {
    return this.runExclusive(async () => {
      const store = createVoiceLeaseStore(this.env.DB);
      return store.getActive(this.sessionId());
    });
  }

  async setVoiceResumeHandle(input: {
    actorId: string;
    handle: string | null;
  }): Promise<VoiceLeaseResult> {
    return this.runExclusive(async () => {
      const store = createVoiceLeaseStore(this.env.DB);
      return store.setResumeHandle(this.sessionId(), input.actorId, input.handle);
    });
  }

  async suspendContinuation(input: {
    id?: string;
    actorId: string;
    wakeCondition: ContinuationWakeCondition;
    suspendedReason: string;
    resumeDirective: string;
  }): Promise<ExecutionContinuation> {
    return this.runExclusive(async () => {
      const lease = await createVoiceLeaseStore(this.env.DB).getActive(this.sessionId());
      const store = new D1ContinuationStore(this.env.DB);
      const continuation = await store.suspend(this.sessionId(), {
        ...input,
        providerResumeHandle: lease?.providerResumeHandle ?? null,
      });

      if (continuation.wakeCondition.type === "time") {
        try {
          const schedule = await this.schedule(
            continuation.wakeCondition.wakeAt,
            "wakeContinuation",
            { continuationId: continuation.id },
            { idempotent: true },
          );
          await store.setSchedulerId(continuation.id, schedule.id);
          const scheduled = await store.get(this.sessionId(), continuation.id);
          this.bumpPulse(null, scheduled ?? continuation);
          return scheduled ?? continuation;
        } catch (error) {
          await store.expire(this.sessionId(), continuation.id);
          this.bumpPulse(null, null);
          throw error;
        }
      }

      this.bumpPulse(null, continuation);
      return continuation;
    });
  }

  /** Agents Scheduler callback for a time-based Wake. */
  async wakeContinuation(payload: { continuationId: string }): Promise<void> {
    await this.runExclusive(async () => {
      const store = new D1ContinuationStore(this.env.DB);
      const continuation = await store.wake(this.sessionId(), payload.continuationId);
      if (continuation) this.bumpPulse(null, continuation);
    });
  }

  async getContinuation(): Promise<ExecutionContinuation | null> {
    return this.runExclusive(() =>
      new D1ContinuationStore(this.env.DB).getActive(this.sessionId()),
    );
  }

  async claimContinuationResume(input: {
    continuationId: string;
    actorId: string;
  }): Promise<ContinuationClaimResult> {
    return this.runExclusive(async () => {
      const result = await new D1ContinuationStore(this.env.DB).claimResume(
        this.sessionId(),
        input.continuationId,
        input.actorId,
      );
      if (result.ok) {
        const attemptId = result.continuation.resumeAttemptId;
        if (!attemptId) throw new Error("Claimed continuation has no resume attempt id");
        try {
          await this.schedule(
            RESUME_CLAIM_TIMEOUT_SECONDS,
            "recoverStaleContinuationResume",
            { continuationId: input.continuationId, attemptId },
            { idempotent: true },
          );
        } catch (error) {
          await new D1ContinuationStore(this.env.DB).failResume(
            this.sessionId(),
            input.continuationId,
            "system",
            attemptId,
          );
          throw error;
        }
        this.bumpPulse(null, result.continuation);
      }
      return result;
    });
  }

  async completeContinuation(input: {
    continuationId: string;
    actorId: string;
    attemptId: string;
  }): Promise<ExecutionContinuation | null> {
    return this.runExclusive(async () => {
      const continuation = await new D1ContinuationStore(this.env.DB).complete(
        this.sessionId(),
        input.continuationId,
        input.actorId,
        input.attemptId,
      );
      if (continuation) this.bumpPulse(null, null);
      return continuation;
    });
  }

  async failContinuationResume(input: {
    continuationId: string;
    actorId: string;
    attemptId: string;
  }): Promise<ExecutionContinuation | null> {
    return this.runExclusive(async () => {
      const continuation = await new D1ContinuationStore(this.env.DB).failResume(
        this.sessionId(),
        input.continuationId,
        input.actorId,
        input.attemptId,
      );
      if (continuation) this.bumpPulse(null, continuation);
      return continuation;
    });
  }

  /** Scheduler recovery for clients that disappear after claiming resume. */
  async recoverStaleContinuationResume(payload: {
    continuationId: string;
    attemptId: string;
  }): Promise<void> {
    await this.runExclusive(async () => {
      const continuation = await new D1ContinuationStore(this.env.DB).failResume(
        this.sessionId(),
        payload.continuationId,
        "system",
        payload.attemptId,
      );
      if (continuation) this.bumpPulse(null, continuation);
    });
  }

  async proposeReplan(input: {
    actorId: string;
    mode: ReplanMode;
    patch: PlanPatch;
    candidateWorldState: WorldState;
    expectedCauseEventIds: string[];
    expectedAffectedStepIds: string[];
    domainVersion: number;
    normalizedInputRevision: number | null;
    capabilityPolicies: ReplanCapabilityPolicy[];
  }): Promise<ReplanMutationResult> {
    return this.runExclusive(async () => {
      const result = await new D1ReplanStore(this.env.DB).propose({
        sessionId: this.sessionId(),
        actorId: input.actorId,
        mode: input.mode,
        patch: input.patch,
        candidateWorldState: input.candidateWorldState,
        expectedCauseEventIds: input.expectedCauseEventIds,
        expectedAffectedStepIds: input.expectedAffectedStepIds,
        domainVersion: input.domainVersion,
        normalizedInputRevision: input.normalizedInputRevision,
        capabilityPolicies: input.capabilityPolicies,
      });
      const state = await this.publishAfterMutation({
        event: result.event,
        state: result.state,
      });
      return { ...result, state };
    });
  }

  async confirmReplan(input: {
    actorId: string;
    patchId: string;
    humanConfirmed: boolean;
    domainVersion: number;
    capabilityPolicies: ReplanCapabilityPolicy[];
  }): Promise<ReplanMutationResult> {
    return this.runExclusive(async () => {
      const result = await new D1ReplanStore(this.env.DB).activatePending({
        sessionId: this.sessionId(),
        actorId: input.actorId,
        patchId: input.patchId,
        humanConfirmed: input.humanConfirmed,
        domainVersion: input.domainVersion,
        capabilityPolicies: input.capabilityPolicies,
      });
      const state = await this.publishAfterMutation({
        event: result.event,
        state: result.state,
      });
      return { ...result, state };
    });
  }

  async getLatestPlanChange(): Promise<PlanChange | null> {
    return this.runExclusive(() => new D1ReplanStore(this.env.DB).getLatest(this.sessionId()));
  }

  private async appendAndPublishEvent(event: RuntimeEvent): Promise<AppendEventResult> {
    const result = await this.repository().appendEvent(event);
    const deliveryEvent =
      result.kind === "applied"
        ? result.event
        : await this.env.DB.prepare(
            `SELECT event_json FROM runtime_events
             WHERE session_id = ? AND id = ? AND idempotency_key = ?`,
          )
            .bind(event.sessionId, event.id, event.idempotencyKey)
            .first<{ event_json: string }>()
            .then((row) => (row ? parseRuntimeEvent(row.event_json) : null));
    const state = await this.publishAfterMutation({
      event: deliveryEvent,
      state: result.state,
      fallbackEventId: deliveryEvent?.id ?? result.event.id,
    });
    return { ...result, state };
  }

  /**
   * Wake Continuations for a committed event, reload state if needed, and bump
   * the client invalidation pulse. Call only under {@link runExclusive}.
   */
  private async publishAfterMutation(input: {
    event: RuntimeEvent | null;
    state: MaterializedExecutionState;
    fallbackEventId?: string | null;
  }): Promise<MaterializedExecutionState> {
    const continuation = input.event
      ? await new D1ContinuationStore(this.env.DB).wakeForEvent(input.event)
      : null;
    const responseState = continuation
      ? ((await this.repository().get(this.sessionId())) ?? input.state)
      : input.state;
    this.bumpPulse(
      responseState.appliedEventIds[responseState.appliedEventIds.length - 1] ??
        input.fallbackEventId ??
        null,
      continuation ?? undefined,
    );
    return responseState;
  }

  /**
   * Advance the client invalidation pulse. Cheap: no D1 snapshot load.
   * Must be called under {@link runExclusive} when concurrent with other writers.
   */
  private bumpPulse(lastEventId: string | null, continuation?: ExecutionContinuation | null): void {
    const previous = this.state ?? EMPTY_SYNC_STATE;
    this.setState({
      revision: previous.revision + 1,
      lastEventId,
      continuation: continuation === undefined ? previous.continuation : continuation,
    });
  }

  /**
   * If Agent state is still empty but D1 has the session, seed a pulse so
   * reconnecting clients see a non-zero revision. Uses a 1-event snapshot only.
   */
  private async ensureSyncPulse(): Promise<void> {
    const current = this.state ?? EMPTY_SYNC_STATE;
    if (current.revision > 0) return;

    const snapshot = await this.repository().getSnapshot(this.sessionId(), {
      recentEventLimit: 1,
    });
    if (snapshot === undefined) return;

    const last = snapshot.recentEvents[snapshot.recentEvents.length - 1];
    this.setState({
      revision: 1,
      lastEventId: last?.id ?? null,
      continuation: await new D1ContinuationStore(this.env.DB).getActive(this.sessionId()),
    });
  }

  private sessionId(): string {
    const name = this.name;
    if (!name) throw new Error("ExecutionSessionAgent has no session name");
    return name;
  }

  private assertSession(sessionId: string): void {
    const expected = this.sessionId();
    if (sessionId !== expected) {
      throw new Error(`Event session ${sessionId} does not match agent session ${expected}`);
    }
  }
}

export type { AppendEventResult, MaterializedExecutionState, RuntimeEvent, RuntimeSnapshot };
