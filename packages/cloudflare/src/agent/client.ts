import { getAgentByName } from "agents";
import type {
  AppendEventResult,
  GetSnapshotOptions,
  MaterializedExecutionState,
  RuntimeEvent,
  RuntimeSnapshot,
} from "@pear-agent/core";

import type { PearEnv } from "../env.js";

/**
 * Typed Worker→Agent RPC surface.
 * Avoid `DurableObjectStub<ExecutionSessionAgent>` — Zod-inferred Core unions
 * make stub type instantiation excessively deep under tsgo.
 */
export type ExecutionSessionAgentRpc = {
  createSession(input: {
    initialState: MaterializedExecutionState;
    domainId: string;
    normalizedInput?: unknown;
  }): Promise<{ ok: true }>;
  getState(): Promise<MaterializedExecutionState | null>;
  appendEvent(event: RuntimeEvent): Promise<AppendEventResult>;
  getSnapshot(options?: GetSnapshotOptions): Promise<RuntimeSnapshot | null>;
  putNormalizedInput(payload: unknown): Promise<{ ok: true }>;
  getNormalizedInput(): Promise<unknown | null>;
};

export async function getExecutionSessionAgent(
  env: PearEnv,
  sessionId: string,
): Promise<ExecutionSessionAgentRpc> {
  const stub = await getAgentByName(env.ExecutionSessionAgent as never, sessionId);
  return stub as unknown as ExecutionSessionAgentRpc;
}

export async function agentCreateSession(
  env: PearEnv,
  input: {
    sessionId: string;
    domainId: string;
    initialState: MaterializedExecutionState;
    /** When set, stored in the same D1 batch as session create. */
    normalizedInput?: unknown;
  },
): Promise<void> {
  const agent = await getExecutionSessionAgent(env, input.sessionId);
  await agent.createSession({
    initialState: input.initialState,
    domainId: input.domainId,
    ...(input.normalizedInput === undefined ? {} : { normalizedInput: input.normalizedInput }),
  });
}

export async function agentGetState(
  env: PearEnv,
  sessionId: string,
): Promise<MaterializedExecutionState | undefined> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  const state = await agent.getState();
  return state ?? undefined;
}

export async function agentAppendEvent(
  env: PearEnv,
  event: RuntimeEvent,
): Promise<AppendEventResult> {
  const agent = await getExecutionSessionAgent(env, event.sessionId);
  return agent.appendEvent(event);
}

export async function agentGetSnapshot(
  env: PearEnv,
  sessionId: string,
  options?: { recentEventLimit?: number },
): Promise<RuntimeSnapshot | undefined> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  const snapshot = await agent.getSnapshot(options);
  return snapshot ?? undefined;
}

export async function agentPutNormalizedInput(
  env: PearEnv,
  sessionId: string,
  payload: unknown,
): Promise<void> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  await agent.putNormalizedInput(payload);
}

export async function agentGetNormalizedInput(
  env: PearEnv,
  sessionId: string,
): Promise<unknown | undefined> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  const payload = await agent.getNormalizedInput();
  return payload === null ? undefined : payload;
}
