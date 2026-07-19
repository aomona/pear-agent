import { getAgentByName } from "agents";
import type {
  AppendEventResult,
  GetSnapshotOptions,
  MaterializedExecutionState,
  RuntimeEvent,
  RuntimeSnapshot,
  VoiceLease,
  ContinuationWakeCondition,
  ExecutionContinuation,
  PlanChange,
  PlanPatch,
  ReplanCapabilityPolicy,
  ReplanMode,
  WorldState,
} from "@pear-agent/core";
import type { ContinuationClaimResult } from "../continuation/store.js";
import type { ReplanMutationResult } from "../replan/store.js";

import type { PearEnv } from "../env.js";
import type { VoiceLeaseResult } from "../voice/results.js";
import type { ExecutionSessionSyncState } from "./sync-state.js";

/**
 * Typed Worker→Agent RPC surface.
 * Avoid `DurableObjectStub<ExecutionSessionAgent>` — Zod-inferred Core unions
 * make stub type instantiation excessively deep under tsgo.
 *
 * Voice lease mutations return {@link VoiceLeaseResult} (not thrown errors) so
 * DO RPC does not strip custom Error subclasses.
 */
export type ExecutionSessionAgentRpc = {
  createSession(input: {
    initialState: MaterializedExecutionState;
    domainId: string;
    domainVersion: number;
    normalizedInput?: unknown;
  }): Promise<{ ok: true }>;
  getState(): Promise<MaterializedExecutionState | null>;
  appendEvent(event: RuntimeEvent): Promise<AppendEventResult>;
  appendReplanFailure(input: {
    actorId: string;
    attemptId: string;
    reason: string;
  }): Promise<AppendEventResult>;
  getSnapshot(options?: GetSnapshotOptions): Promise<RuntimeSnapshot | null>;
  putNormalizedInput(payload: unknown): Promise<{ ok: true }>;
  getNormalizedInput(): Promise<unknown | null>;
  getNormalizedInputRecord(): Promise<{ payload: unknown; revision: number } | null>;
  getSyncState(): Promise<ExecutionSessionSyncState>;
  acquireVoiceLease(input: {
    actorId: string;
    leaseId?: string;
    ttlMs?: number;
  }): Promise<VoiceLeaseResult>;
  releaseVoiceLease(input: { actorId: string }): Promise<VoiceLeaseResult>;
  getVoiceLease(): Promise<VoiceLease | null>;
  setVoiceResumeHandle(input: {
    actorId: string;
    handle: string | null;
    leaseId?: string;
    expectedHandles?: readonly (string | null)[];
  }): Promise<VoiceLeaseResult>;
  suspendContinuation(input: {
    id?: string;
    actorId: string;
    wakeCondition: ContinuationWakeCondition;
    suspendedReason: string;
    resumeDirective: string;
  }): Promise<ExecutionContinuation>;
  getContinuation(): Promise<ExecutionContinuation | null>;
  claimContinuationResume(input: {
    continuationId: string;
    actorId: string;
  }): Promise<ContinuationClaimResult>;
  completeContinuation(input: {
    continuationId: string;
    actorId: string;
    attemptId: string;
  }): Promise<ExecutionContinuation | null>;
  failContinuationResume(input: {
    continuationId: string;
    actorId: string;
    attemptId: string;
  }): Promise<ExecutionContinuation | null>;
  wakeContinuation(input: { continuationId: string }): Promise<void>;
  recoverStaleContinuationResume(input: {
    continuationId: string;
    attemptId: string;
  }): Promise<void>;
  proposeReplan(input: {
    actorId: string;
    mode: ReplanMode;
    patch: PlanPatch;
    candidateWorldState: WorldState;
    expectedCauseEventIds: string[];
    expectedAffectedStepIds: string[];
    domainVersion: number;
    normalizedInputRevision: number | null;
    capabilityPolicies: ReplanCapabilityPolicy[];
  }): Promise<ReplanMutationResult>;
  confirmReplan(input: {
    actorId: string;
    patchId: string;
    humanConfirmed: boolean;
    domainVersion: number;
    capabilityPolicies: ReplanCapabilityPolicy[];
  }): Promise<ReplanMutationResult>;
  getLatestPlanChange(): Promise<PlanChange | null>;
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
    domainVersion: number;
    initialState: MaterializedExecutionState;
    /** When set, stored in the same D1 batch as session create. */
    normalizedInput?: unknown;
  },
): Promise<void> {
  const agent = await getExecutionSessionAgent(env, input.sessionId);
  await agent.createSession({
    initialState: input.initialState,
    domainId: input.domainId,
    domainVersion: input.domainVersion,
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

export async function agentAppendReplanFailure(
  env: PearEnv,
  sessionId: string,
  input: { actorId: string; attemptId: string; reason: string },
): Promise<AppendEventResult> {
  return (await getExecutionSessionAgent(env, sessionId)).appendReplanFailure(input);
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

export async function agentGetNormalizedInputRecord(
  env: PearEnv,
  sessionId: string,
): Promise<{ payload: unknown; revision: number } | undefined> {
  const record = await (await getExecutionSessionAgent(env, sessionId)).getNormalizedInputRecord();
  return record ?? undefined;
}

export async function agentAcquireVoiceLease(
  env: PearEnv,
  sessionId: string,
  input: { actorId: string; leaseId?: string; ttlMs?: number },
): Promise<VoiceLeaseResult> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  return agent.acquireVoiceLease(input);
}

export async function agentReleaseVoiceLease(
  env: PearEnv,
  sessionId: string,
  input: { actorId: string },
): Promise<VoiceLeaseResult> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  return agent.releaseVoiceLease(input);
}

export async function agentGetVoiceLease(
  env: PearEnv,
  sessionId: string,
): Promise<VoiceLease | null> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  return agent.getVoiceLease();
}

export async function agentSetVoiceResumeHandle(
  env: PearEnv,
  sessionId: string,
  input: {
    actorId: string;
    handle: string | null;
    leaseId?: string;
    expectedHandles?: readonly (string | null)[];
  },
): Promise<VoiceLeaseResult> {
  const agent = await getExecutionSessionAgent(env, sessionId);
  return agent.setVoiceResumeHandle(input);
}

export async function agentSuspendContinuation(
  env: PearEnv,
  sessionId: string,
  input: {
    id?: string;
    actorId: string;
    wakeCondition: ContinuationWakeCondition;
    suspendedReason: string;
    resumeDirective: string;
  },
): Promise<ExecutionContinuation> {
  return (await getExecutionSessionAgent(env, sessionId)).suspendContinuation(input);
}

export async function agentGetContinuation(
  env: PearEnv,
  sessionId: string,
): Promise<ExecutionContinuation | null> {
  return (await getExecutionSessionAgent(env, sessionId)).getContinuation();
}

export async function agentClaimContinuationResume(
  env: PearEnv,
  sessionId: string,
  input: { continuationId: string; actorId: string },
): Promise<ContinuationClaimResult> {
  return (await getExecutionSessionAgent(env, sessionId)).claimContinuationResume(input);
}

export async function agentCompleteContinuation(
  env: PearEnv,
  sessionId: string,
  input: { continuationId: string; actorId: string },
  attemptId: string,
): Promise<ExecutionContinuation | null> {
  return (await getExecutionSessionAgent(env, sessionId)).completeContinuation({
    ...input,
    attemptId,
  });
}

export async function agentFailContinuationResume(
  env: PearEnv,
  sessionId: string,
  input: { continuationId: string; actorId: string },
  attemptId: string,
): Promise<ExecutionContinuation | null> {
  return (await getExecutionSessionAgent(env, sessionId)).failContinuationResume({
    ...input,
    attemptId,
  });
}

export async function agentProposeReplan(
  env: PearEnv,
  sessionId: string,
  input: Parameters<ExecutionSessionAgentRpc["proposeReplan"]>[0],
): Promise<ReplanMutationResult> {
  return (await getExecutionSessionAgent(env, sessionId)).proposeReplan(input);
}

export async function agentConfirmReplan(
  env: PearEnv,
  sessionId: string,
  input: Parameters<ExecutionSessionAgentRpc["confirmReplan"]>[0],
): Promise<ReplanMutationResult> {
  return (await getExecutionSessionAgent(env, sessionId)).confirmReplan(input);
}

export async function agentGetLatestPlanChange(
  env: PearEnv,
  sessionId: string,
): Promise<PlanChange | null> {
  return (await getExecutionSessionAgent(env, sessionId)).getLatestPlanChange();
}
