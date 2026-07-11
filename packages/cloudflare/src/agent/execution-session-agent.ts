import type {
  AppendEventResult,
  GetSnapshotOptions,
  MaterializedExecutionState,
  RuntimeEvent,
  RuntimeSnapshot,
  VoiceLease,
} from "@pear-agent/core";
import { Agent, type Connection, type ConnectionContext } from "agents";

import { D1ExecutionStateRepository } from "../d1/repository.js";
import type { PearEnv } from "../env.js";
import { createVoiceLeaseStore } from "../voice/lease-store.js";
import type { VoiceLeaseResult } from "../voice/results.js";
import { EMPTY_SYNC_STATE, type ExecutionSessionSyncState } from "./sync-state.js";

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
    return this.runExclusive(async () => {
      const result = await this.repository().appendEvent(event);
      this.bumpPulse(result.event.id);
      return result;
    });
  }

  async getSnapshot(options?: GetSnapshotOptions): Promise<RuntimeSnapshot | null> {
    return this.runExclusive(async () => {
      const snapshot = await this.repository().getSnapshot(this.sessionId(), options);
      return snapshot ?? null;
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

  /** Current invalidation pulse (for tests and diagnostics). */
  async getSyncState(): Promise<ExecutionSessionSyncState> {
    return this.state;
  }

  // --- Voice Lease (Issue #6); does not mutate Execution Session status ---
  // Returns Result objects so DO RPC does not strip typed HTTP errors.

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

  /**
   * Advance the client invalidation pulse. Cheap: no D1 snapshot load.
   * Must be called under {@link runExclusive} when concurrent with other writers.
   */
  private bumpPulse(lastEventId: string | null): void {
    const previous = this.state ?? EMPTY_SYNC_STATE;
    this.setState({
      revision: previous.revision + 1,
      lastEventId,
      continuation: null,
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
      continuation: null,
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
