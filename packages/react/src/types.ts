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
export type ConnectionStatus = "idle" | "loading" | "connected" | "reconnecting" | "error";

/** @deprecated Use ExecutionContinuation from @pear-agent/core. */
export type ExecutionContinuationStub = import("@pear-agent/core").ExecutionContinuation;

/**
 * Agent DO invalidation pulse (JSON wire).
 * Clients re-fetch Runtime Snapshot over HTTP when `revision` advances.
 */
export type ExecutionSessionSyncState = {
  revision: number;
  lastEventId: string | null;
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

export type ParsedSyncPulse = {
  revision: number;
  lastEventId: string | null;
  continuation: ExecutionContinuationStub | null;
};
