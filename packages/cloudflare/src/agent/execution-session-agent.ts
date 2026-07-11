import type {
  AppendEventResult,
  GetSnapshotOptions,
  MaterializedExecutionState,
  RuntimeEvent,
  RuntimeSnapshot,
} from "@pear-agent/core";
import { Agent, type Connection, type ConnectionContext } from "agents";

import { D1ExecutionStateRepository } from "../d1/repository.js";
import type { PearEnv } from "../env.js";
import { toJsonValue } from "../serialize.js";
import { EMPTY_SYNC_STATE, type ExecutionSessionSyncState } from "./sync-state.js";

/** Keep Agent mirror lighter than full HTTP snapshots; clients hydrate events via HTTP. */
const SYNC_RECENT_EVENT_LIMIT = 50;

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
 * {@link ExecutionSessionSyncState} is a broadcast mirror for WebSocket clients
 * (`agents/client` / `agents/react`). It is not the durable PEAR store.
 * WebSocket auth is enforced in {@link createPearWorker} `onBeforeConnect`.
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
   * On (re)connect, rehydrate the sync mirror from D1 so clients converge
   * to the durable snapshot even if Agent SQLite lagged or was empty.
   */
  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    void connection;
    void ctx;
    await this.runExclusive(() => this.publishSyncStateFromD1());
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
      await this.publishSyncStateFromD1();
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
      await this.publishSyncStateFromD1();
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
      // Normalized input is not in the RuntimeSnapshot mirror; bump revision only
      // so clients can re-fetch related HTTP resources without a full D1 snapshot load.
      const previous = this.state ?? EMPTY_SYNC_STATE;
      this.setState({
        revision: previous.revision + 1,
        snapshot: previous.snapshot,
        continuation: null,
      });
      return { ok: true as const };
    });
  }

  async getNormalizedInput(): Promise<unknown | null> {
    return this.runExclusive(async () => {
      const payload = await this.repository().getNormalizedInput(this.sessionId());
      return payload === undefined ? null : payload;
    });
  }

  /** Current broadcast mirror (for tests and diagnostics). */
  async getSyncState(): Promise<ExecutionSessionSyncState> {
    return this.state;
  }

  /**
   * Loads the latest snapshot from D1 and broadcasts via `setState`.
   * Safe when the session row does not exist yet (snapshot stays null).
   * Must be called under {@link runExclusive} when concurrent with other writers.
   */
  private async publishSyncStateFromD1(): Promise<void> {
    const snapshot = await this.repository().getSnapshot(this.sessionId(), {
      recentEventLimit: SYNC_RECENT_EVENT_LIMIT,
    });
    const previous = this.state ?? EMPTY_SYNC_STATE;
    this.setState({
      revision: previous.revision + 1,
      snapshot: snapshot === undefined ? null : toJsonValue(snapshot),
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
