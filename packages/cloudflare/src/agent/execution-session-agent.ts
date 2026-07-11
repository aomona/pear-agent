import type {
  AppendEventResult,
  GetSnapshotOptions,
  MaterializedExecutionState,
  RuntimeEvent,
  RuntimeSnapshot,
} from "@pear-agent/core";
import { Agent } from "agents";

import { D1ExecutionStateRepository } from "../d1/repository.js";
import type { PearEnv } from "../env.js";

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
 */
export class ExecutionSessionAgent extends Agent<PearEnv, Record<string, never>> {
  override initialState: Record<string, never> = {};

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
    return this.runExclusive(() => this.repository().appendEvent(event));
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
      return { ok: true as const };
    });
  }

  async getNormalizedInput(): Promise<unknown | null> {
    return this.runExclusive(async () => {
      const payload = await this.repository().getNormalizedInput(this.sessionId());
      return payload === undefined ? null : payload;
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
