import type { RuntimeSnapshot } from "@pear-agent/core";

/**
 * Host-resolved auth context, sent as `x-pear-context` JSON on HTTP calls.
 * Matches `@pear-agent/cloudflare` `PearRequestContext` shape without importing
 * the Cloudflare package (keeps browser bundles free of Worker types).
 */
export type PearClientContext = {
  actorId: string;
  roles?: string[];
  claims?: Record<string, unknown>;
  requestId?: string;
  sessionId?: string;
};

/** Connection lifecycle for realtime snapshot subscriptions. */
export type ConnectionStatus =
  | "idle"
  | "loading"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

/**
 * Stub Continuation until Issue #7. Always null from the server today.
 * Shape mirrors docs/resume-protocol.md for forward-compatible hooks.
 */
export type ExecutionContinuationStub = {
  id: string;
  sessionId: string;
  status: "suspended" | "wake_pending" | "resuming" | "completed" | "expired";
  wakeCondition:
    | { type: "manual" }
    | { type: "time"; wakeAt: string }
    | { type: "event"; eventType: string };
  suspendedReason: string;
  resumeDirective: string;
  checkpointPlanVersionId: string;
  checkpointLastEventId: string | null;
  providerResumeHandle: string | null;
};

/** Agent DO broadcast mirror (JSON wire). */
export type ExecutionSessionSyncState = {
  revision: number;
  snapshot: unknown | null;
  continuation: ExecutionContinuationStub | null;
};

export type AsyncStatus = "idle" | "loading" | "success" | "error";

export type CreateSessionInput = {
  sessionId?: string;
  domainId: string;
  actorIds: string[];
  goal: unknown;
  normalizedInput: unknown;
};

export type CreateSessionResult = {
  sessionId: string;
  session: unknown;
  plan: unknown;
  stepStates: unknown;
};

export type AppendEventInput = {
  id?: string;
  idempotencyKey?: string;
  actorId?: string;
  origin?: string;
  occurredAt?: Date | string;
};

/** Helpers that construct typed RuntimeEvents for common UI actions. */
export type StepActionInput = AppendEventInput & {
  stepId: string;
};

export type TimerStartInput = AppendEventInput & {
  timerId: string;
  durationSeconds?: number;
};

export type TimerActionInput = AppendEventInput & {
  timerId: string;
};

export type DomainEventInput = AppendEventInput & {
  domainType: string;
  payload: unknown;
};

export type ParsedSyncSnapshot = {
  revision: number;
  snapshot: RuntimeSnapshot | null;
  continuation: ExecutionContinuationStub | null;
};
