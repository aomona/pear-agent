import { getAgentByName } from "agents";
import type {
  AppendEventResult,
  MaterializedExecutionState,
  RuntimeEvent,
  RuntimeSnapshot,
} from "@pear-agent/core";

import type { PearEnv } from "../env.js";
import {
  parseExecutionState,
  parseRuntimeSnapshot,
  serializeExecutionState,
  serializeRuntimeEvent,
} from "../serialize.js";
import { ExecutionSessionAgent, parseAppendEventResult } from "./execution-session-agent.js";

export async function getExecutionSessionAgent(
  env: PearEnv,
  sessionId: string,
): Promise<DurableObjectStub<ExecutionSessionAgent>> {
  // getAgentByName is typed against a generic Agent; cast to our RPC surface.
  const stub = await getAgentByName(env.ExecutionSessionAgent as never, sessionId);
  return stub as unknown as DurableObjectStub<ExecutionSessionAgent>;
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
    initialStateJson: serializeExecutionState(input.initialState),
    domainId: input.domainId,
    ...(input.normalizedInput === undefined
      ? {}
      : { normalizedInputJson: JSON.stringify(input.normalizedInput) }),
  });
}

export async function agentGetState(
  env: PearEnv,
  sessionId: string,
): Promise<MaterializedExecutionState | undefined> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  const json = await agent.getState();
  return json ? parseExecutionState(json) : undefined;
}

export async function agentAppendEvent(
  env: PearEnv,
  event: RuntimeEvent,
): Promise<AppendEventResult> {
  const agent = await getExecutionSessionAgent(env, event.sessionId);
  const json = await agent.appendEvent(serializeRuntimeEvent(event));
  return parseAppendEventResult(json);
}

export async function agentGetSnapshot(
  env: PearEnv,
  sessionId: string,
  options?: { recentEventLimit?: number },
): Promise<RuntimeSnapshot | undefined> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  const json = await agent.getSnapshot(options ? JSON.stringify(options) : undefined);
  return json ? parseRuntimeSnapshot(json) : undefined;
}

export async function agentPutNormalizedInput(
  env: PearEnv,
  sessionId: string,
  payload: unknown,
): Promise<void> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  await agent.putNormalizedInput(JSON.stringify(payload));
}

export async function agentGetNormalizedInput(
  env: PearEnv,
  sessionId: string,
): Promise<unknown | undefined> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  const json = await agent.getNormalizedInput();
  return json === null ? undefined : (JSON.parse(json) as unknown);
}
