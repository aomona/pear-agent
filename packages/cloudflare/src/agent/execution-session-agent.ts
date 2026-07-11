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
 */
export class ExecutionSessionAgent extends Agent<PearEnv, Record<string, never>> {
  override initialState: Record<string, never> = {};

  private repository(): D1ExecutionStateRepository {
    return new D1ExecutionStateRepository(this.env.DB);
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

    await this.repository().createWithDomain(input.initialState, {
      domainId: input.domainId,
      ...(input.normalizedInput === undefined ? {} : { normalizedInput: input.normalizedInput }),
    });
    return { ok: true };
  }

  async getState(): Promise<MaterializedExecutionState | null> {
    const state = await this.repository().get(this.sessionId());
    return state ?? null;
  }

  async appendEvent(event: RuntimeEvent): Promise<AppendEventResult> {
    this.assertSession(event.sessionId);
    return this.repository().appendEvent(event);
  }

  async getSnapshot(options?: GetSnapshotOptions): Promise<RuntimeSnapshot | null> {
    const snapshot = await this.repository().getSnapshot(this.sessionId(), options);
    return snapshot ?? null;
  }

  async putNormalizedInput(payload: unknown): Promise<{ ok: true }> {
    await this.repository().putNormalizedInput(this.sessionId(), payload);
    return { ok: true };
  }

  async getNormalizedInput(): Promise<unknown | null> {
    const payload = await this.repository().getNormalizedInput(this.sessionId());
    return payload === undefined ? null : payload;
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
