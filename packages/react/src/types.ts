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

/**
 * Create an Execution Session either by generating a plan (goal + normalizedInput)
 * or by starting from a ready plan library artifact (`planArtifactId`).
 */
export type CreateSessionInput = {
  sessionId?: string | undefined;
  domainId: string;
  actorIds: string[];
  /** Required unless `planArtifactId` is set (artifact supplies goal). */
  goal?: unknown;
  /** Required unless stored on the plan artifact. */
  normalizedInput?: unknown;
  worldState?: import("@pear-agent/core").WorldState | undefined;
  /** Ready CE-11 plan artifact — skips PlanGenerator. */
  planArtifactId?: string | undefined;
};

export type PlanListItem = {
  id: string;
  domainId: string;
  status: "draft" | "ready" | "archived";
  title?: string | undefined;
  version: number;
  goalId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PlanArtifactDetail = {
  id: string;
  domainId: string;
  status: "draft" | "ready" | "archived";
  title?: string | undefined;
  version: number;
  goal: unknown;
  currentPlan: import("@pear-agent/core").ExecutionPlan;
  createdAt: Date;
  updatedAt: Date;
  normalizedInput?: unknown;
  ownerActorId?: string | null | undefined;
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
