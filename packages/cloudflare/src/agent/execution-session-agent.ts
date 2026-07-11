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
import {
  parseExecutionState,
  parseRuntimeEvent,
  serializeExecutionState,
  serializeRuntimeEvent,
  serializeRuntimeSnapshot,
} from "../serialize.js";

export type ExecutionSessionAgentState = {
  sessionId: string | null;
};

/**
 * Per-session Durable Agent. Serializes mutations for one Execution Session
 * while D1 remains the durable source of truth for state and the event log.
 */
export class ExecutionSessionAgent extends Agent<PearEnv, ExecutionSessionAgentState> {
  override initialState: ExecutionSessionAgentState = { sessionId: null };

  private repository(domainId?: string): D1ExecutionStateRepository {
    return new D1ExecutionStateRepository(this.env.DB, domainId ? { domainId } : {});
  }

  /**
   * Creates the session in D1 (and optional initial normalized input) in one batch.
   * Agent name must equal `state.session.id`.
   */
  async createSession(input: {
    initialStateJson: string;
    domainId: string;
    /** JSON string of Domain normalized input; written in the same D1 batch. */
    normalizedInputJson?: string;
  }): Promise<{ ok: true }> {
    const state = parseExecutionState(input.initialStateJson);
    const agentName = this.name;
    if (!agentName) {
      throw new Error("ExecutionSessionAgent has no session name");
    }
    if (state.session.id !== agentName) {
      throw new Error(
        `Session id ${state.session.id} does not match agent name ${agentName}`,
      );
    }

    const normalizedInput =
      input.normalizedInputJson === undefined
        ? undefined
        : (JSON.parse(input.normalizedInputJson) as unknown);

    await this.repository(input.domainId).create(
      state,
      normalizedInput === undefined ? {} : { normalizedInput },
    );
    this.setState({ sessionId: state.session.id });
    return { ok: true };
  }

  async getState(): Promise<string | null> {
    const sessionId = this.requireSessionId();
    const state = await this.repository().get(sessionId);
    return state ? serializeExecutionState(state) : null;
  }

  async appendEvent(eventJson: string): Promise<string> {
    const event = parseRuntimeEvent(eventJson);
    this.assertSession(event.sessionId);
    const result = await this.repository().appendEvent(event);
    return serializeAppendEventResult(result);
  }

  async getSnapshot(optionsJson?: string): Promise<string | null> {
    const sessionId = this.requireSessionId();
    const options = optionsJson
      ? (JSON.parse(optionsJson) as GetSnapshotOptions)
      : undefined;
    const snapshot = await this.repository().getSnapshot(sessionId, options);
    return snapshot ? serializeRuntimeSnapshot(snapshot) : null;
  }

  async putNormalizedInput(payloadJson: string): Promise<{ ok: true }> {
    const sessionId = this.requireSessionId();
    await this.repository().putNormalizedInput(sessionId, JSON.parse(payloadJson) as unknown);
    return { ok: true };
  }

  async getNormalizedInput(): Promise<string | null> {
    const sessionId = this.requireSessionId();
    const payload = await this.repository().getNormalizedInput(sessionId);
    return payload === undefined ? null : JSON.stringify(payload);
  }

  private requireSessionId(): string {
    const fromState = this.state.sessionId;
    if (fromState) return fromState;
    // After hibernation / cold start, derive from Durable Object name.
    const name = this.name;
    if (!name) throw new Error("ExecutionSessionAgent has no session name");
    this.setState({ sessionId: name });
    return name;
  }

  private assertSession(sessionId: string): void {
    const expected = this.requireSessionId();
    if (sessionId !== expected) {
      throw new Error(`Event session ${sessionId} does not match agent session ${expected}`);
    }
  }
}

function serializeAppendEventResult(result: AppendEventResult): string {
  return JSON.stringify({
    kind: result.kind,
    event: JSON.parse(serializeRuntimeEvent(result.event)),
    state: JSON.parse(serializeExecutionState(result.state)),
  });
}

export function parseAppendEventResult(json: string): AppendEventResult {
  const parsed = JSON.parse(json) as {
    kind: AppendEventResult["kind"];
    event: unknown;
    state: unknown;
  };
  return {
    kind: parsed.kind,
    event: parseRuntimeEvent(JSON.stringify(parsed.event)),
    state: parseExecutionState(JSON.stringify(parsed.state)),
  };
}

export type {
  AppendEventResult,
  MaterializedExecutionState,
  RuntimeEvent,
  RuntimeSnapshot,
};
