import {
  dateSchema,
  executionPlanSchema,
  executionSessionSchema,
  affectedSubgraphSchema,
  planArtifactStatusSchema,
  replanAssessmentSchema,
  runtimeEventSchema,
  stepStatesSchema,
  type AppendEventResult,
  type ExecutionPlan,
  type ExecutionSession,
  type ExecutionContinuation,
  type ContinuationWakeCondition,
  type MaterializedExecutionState,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type StepStates,
  type VoiceLease,
  type PlanChange,
  type ReplanAssessment,
  type ReplanMode,
  type AffectedSubgraph,
} from "@pear-agent/core";
import { z } from "zod";

import { PEAR_CONTEXT_HEADER, serializePearClientContext } from "./context-wire.js";
import { PearClientError } from "./errors.js";
import {
  parseAppendEventResult,
  parseMaterializedState,
  parseRuntimeSnapshot,
  parseVoiceLease,
  parseVoiceLeaseOrNull,
  parseExecutionContinuation,
  parsePlanChange,
} from "./parse.js";
import type {
  AppendEventInput,
  CreateSessionInput,
  DomainEventInput,
  PearClientContext,
  PlanArtifactDetail,
  PlanListItem,
  StepActionInput,
  TimerActionInput,
  TimerStartInput,
} from "./types.js";

export type PearClientOptions = {
  /** Worker origin, e.g. `https://my-worker.example.workers.dev` or `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** Host resolves auth into PEAR context for each request. */
  getContext: () => PearClientContext | Promise<PearClientContext>;
  fetch?: typeof fetch;
};

export type CreateSessionResult = {
  sessionId: string;
  session: ExecutionSession;
  plan: ExecutionPlan;
  stepStates: StepStates;
  planArtifactId?: string | undefined;
};

/**
 * Successful HTTP 200 replan outcomes. Pre-commit generation/validation failures
 * throw {@link PearClientError} (HTTP 4xx) with body `{ kind: "failed", attemptId, reason }`.
 */
export type RequestReplanResult =
  | { kind: "not_needed"; assessment: ReplanAssessment }
  | {
      kind: "applied" | "pending_confirmation" | "suggested" | "failed";
      assessment: ReplanAssessment;
      affectedSubgraph: AffectedSubgraph;
      planChange: PlanChange;
      state: MaterializedExecutionState;
    };

const createSessionResultSchema = z.object({
  sessionId: z.string().min(1),
  session: executionSessionSchema,
  plan: executionPlanSchema(z.unknown()),
  stepStates: stepStatesSchema,
  planArtifactId: z.string().min(1).optional(),
});

const optionalTitle = z.preprocess(
  (value) => (value === null || value === "" ? undefined : value),
  z.string().min(1).max(160).optional(),
);

const planListItemSchema = z.object({
  id: z.string().min(1),
  domainId: z.string().min(1),
  status: planArtifactStatusSchema,
  title: optionalTitle,
  version: z.number().int().positive(),
  goalId: z.string().min(1),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

const planArtifactDetailSchema = z.object({
  id: z.string().min(1),
  domainId: z.string().min(1),
  status: planArtifactStatusSchema,
  title: optionalTitle,
  version: z.number().int().positive(),
  goal: z.unknown(),
  currentPlan: executionPlanSchema(z.unknown()),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  normalizedInput: z.unknown().optional(),
  ownerActorId: z.string().nullable().optional(),
});

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Typed HTTP client for the PEAR Worker API (`createPearApp` / `createPearWorker`).
 * Does not open WebSockets; realtime is handled by hooks + `agents/client`.
 */
export class PearClient {
  readonly baseUrl: string;
  private getContext: PearClientOptions["getContext"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: PearClientOptions) {
    this.baseUrl = options.baseUrl;
    this.getContext = options.getContext;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Replace the context resolver without constructing a new client.
   * Used by {@link PearProvider} so inline `getContext` props stay stable.
   */
  setGetContext(getContext: PearClientOptions["getContext"]): void {
    this.getContext = getContext;
  }

  async health(): Promise<{ ok: true }> {
    const response = await this.fetchImpl(joinUrl(this.baseUrl, "/health"));
    if (!response.ok) {
      throw await this.toError(response);
    }
    return (await response.json()) as { ok: true };
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const body = await this.requestJson<unknown>("/sessions", {
      method: "POST",
      body: input,
    });
    return createSessionResultSchema.parse(body);
  }

  async listPlans(filter?: {
    domainId?: string;
    status?: "draft" | "ready" | "archived";
  }): Promise<PlanListItem[]> {
    const params = new URLSearchParams();
    if (filter?.domainId !== undefined) params.set("domainId", filter.domainId);
    if (filter?.status !== undefined) params.set("status", filter.status);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.requestJson<{ plans: unknown }>(`/plans${query}`);
    return z.array(planListItemSchema).parse(body.plans);
  }

  async createPlan(input: {
    id?: string;
    domainId: string;
    goal: unknown;
    title?: string;
    plan?: unknown;
    status?: "draft" | "ready" | "archived";
    normalizedInput?: unknown;
  }): Promise<PlanArtifactDetail> {
    const body = await this.requestJson<{ artifact: unknown }>("/plans", {
      method: "POST",
      body: input,
    });
    return planArtifactDetailSchema.parse(body.artifact);
  }

  async getPlan(planId: string): Promise<PlanArtifactDetail> {
    const body = await this.requestJson<{ artifact: unknown }>(`/plans/${planId}`);
    return planArtifactDetailSchema.parse(body.artifact);
  }

  async updatePlan(
    planId: string,
    input: {
      title?: string | null;
      status?: "draft" | "ready" | "archived";
      normalizedInput?: unknown;
      plan?: unknown;
      summary?: string;
    },
  ): Promise<PlanArtifactDetail> {
    const body = await this.requestJson<{ artifact: unknown }>(`/plans/${planId}`, {
      method: "PATCH",
      body: input,
    });
    return planArtifactDetailSchema.parse(body.artifact);
  }

  async generatePlanArtifact(
    planId: string,
    input?: { normalizedInput?: unknown; goal?: unknown },
  ): Promise<PlanArtifactDetail> {
    const body = await this.requestJson<{ artifact: unknown }>(`/plans/${planId}/generate`, {
      method: "POST",
      body: input ?? {},
    });
    return planArtifactDetailSchema.parse(body.artifact);
  }

  async normalizePlanInput(planId: string, input: unknown): Promise<PlanArtifactDetail> {
    const body = await this.requestJson<{ artifact: unknown }>(`/plans/${planId}/normalize`, {
      method: "POST",
      body: { input },
    });
    return planArtifactDetailSchema.parse(body.artifact);
  }

  /**
   * Structure one free-text field (deterministic + optional LLM).
   * Used when the user confirms an add-item modal — not while typing.
   */
  async resolvePlanField(
    planId: string,
    input: { field: string; freeText: string },
  ): Promise<{ field: string; value: unknown }> {
    return this.requestJson(`/plans/${planId}/resolve-field`, {
      method: "POST",
      body: input,
    });
  }

  async improvePlan(
    planId: string,
    input: { request: string; constraints?: unknown },
  ): Promise<PlanArtifactDetail> {
    const body = await this.requestJson<{ artifact: unknown }>(`/plans/${planId}/improve`, {
      method: "POST",
      body: input,
    });
    return planArtifactDetailSchema.parse(body.artifact);
  }

  async getSession(sessionId: string): Promise<MaterializedExecutionState> {
    const body = await this.requestJson<{ state: unknown }>(`/sessions/${sessionId}`);
    return parseMaterializedState(body.state);
  }

  async getSnapshot(
    sessionId: string,
    options?: { recentEventLimit?: number },
  ): Promise<RuntimeSnapshot> {
    const params = new URLSearchParams();
    if (options?.recentEventLimit !== undefined) {
      params.set("recentEventLimit", String(options.recentEventLimit));
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.requestJson<{ snapshot: unknown }>(
      `/sessions/${sessionId}/snapshot${query}`,
    );
    return parseRuntimeSnapshot(body.snapshot);
  }

  async appendEvent(sessionId: string, event: RuntimeEvent): Promise<AppendEventResult> {
    if (event.sessionId !== sessionId) {
      throw new Error("event.sessionId must match sessionId argument");
    }
    const body = await this.requestJson<unknown>(`/sessions/${sessionId}/events`, {
      method: "POST",
      body: event,
    });
    return parseAppendEventResult(body);
  }

  async putNormalizedInput(sessionId: string, payload: unknown): Promise<void> {
    await this.requestJson<{ ok: true }>(`/sessions/${sessionId}/normalized-input`, {
      method: "PUT",
      body: payload,
    });
  }

  async getNormalizedInput(sessionId: string): Promise<unknown> {
    const body = await this.requestJson<{ normalizedInput: unknown }>(
      `/sessions/${sessionId}/normalized-input`,
    );
    return body.normalizedInput;
  }

  async startSession(sessionId: string, input: AppendEventInput = {}): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "session_started", {}, input);
  }

  async pauseSession(sessionId: string, input: AppendEventInput = {}): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "session_paused", {}, input);
  }

  async cancelSession(sessionId: string, input: AppendEventInput = {}): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "session_cancelled", {}, input);
  }

  async startStep(sessionId: string, input: StepActionInput): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "step_started", { stepId: input.stepId }, input);
  }

  async completeStep(sessionId: string, input: StepActionInput): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "step_completed", { stepId: input.stepId }, input);
  }

  async failStep(sessionId: string, input: StepActionInput): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "step_failed", { stepId: input.stepId }, input);
  }

  async pauseStep(sessionId: string, input: StepActionInput): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "step_paused", { stepId: input.stepId }, input);
  }

  async skipStep(sessionId: string, input: StepActionInput): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "step_skipped", { stepId: input.stepId }, input);
  }

  async startTimer(sessionId: string, input: TimerStartInput): Promise<AppendEventResult> {
    const payload: { timerId: string; durationSeconds?: number } = { timerId: input.timerId };
    if (input.durationSeconds !== undefined) {
      payload.durationSeconds = input.durationSeconds;
    }
    return this.appendBuiltEvent(sessionId, "timer_started", payload, input);
  }

  async pauseTimer(sessionId: string, input: TimerActionInput): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "timer_paused", { timerId: input.timerId }, input);
  }

  async completeTimer(sessionId: string, input: TimerActionInput): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "timer_completed", { timerId: input.timerId }, input);
  }

  async cancelTimer(sessionId: string, input: TimerActionInput): Promise<AppendEventResult> {
    return this.appendBuiltEvent(sessionId, "timer_cancelled", { timerId: input.timerId }, input);
  }

  async reportDomainEvent(sessionId: string, input: DomainEventInput): Promise<AppendEventResult> {
    const envelope = await this.buildEnvelope(sessionId, input);
    return this.appendEvent(
      sessionId,
      runtimeEventSchema.parse({
        ...envelope,
        type: "domain_event",
        domainType: input.domainType,
        payload: input.payload,
      }),
    );
  }

  async acquireVoiceLease(
    sessionId: string,
    input: { ttlMs?: number; leaseId?: string } = {},
  ): Promise<VoiceLease> {
    const body = await this.requestJson<{ lease: unknown }>(`/sessions/${sessionId}/voice/lease`, {
      method: "POST",
      body: input,
    });
    return parseVoiceLease(body.lease);
  }

  async getVoiceLease(sessionId: string): Promise<VoiceLease | null> {
    const body = await this.requestJson<{ lease: unknown }>(`/sessions/${sessionId}/voice/lease`);
    return parseVoiceLeaseOrNull(body.lease);
  }

  async releaseVoiceLease(sessionId: string): Promise<VoiceLease> {
    const body = await this.requestJson<{ lease: unknown }>(`/sessions/${sessionId}/voice/lease`, {
      method: "DELETE",
    });
    return parseVoiceLease(body.lease);
  }

  async setVoiceResumeHandle(
    sessionId: string,
    handle: string | null,
    options?: { keepalive?: boolean },
  ): Promise<VoiceLease> {
    const body = await this.requestJson<{ lease: unknown }>(
      `/sessions/${sessionId}/voice/resume-handle`,
      {
        method: "PUT",
        body: { handle },
        ...(options?.keepalive === true ? { keepalive: true } : {}),
      },
    );
    return parseVoiceLease(body.lease);
  }

  async mintVoiceToken(sessionId: string): Promise<{ token: string; model: string }> {
    return this.requestJson(`/sessions/${sessionId}/voice/token`, {
      method: "POST",
      body: {},
    });
  }

  async executeVoiceTool(
    sessionId: string,
    input: { toolName: string; args?: Record<string, unknown>; callId?: string },
  ): Promise<
    | { callId: string | null; toolName: string; ok: true; result: unknown }
    | {
        callId: string | null;
        toolName: string;
        ok: false;
        error: true;
        message: string;
      }
  > {
    return this.requestJson(`/sessions/${sessionId}/voice/tools`, {
      method: "POST",
      body: {
        toolName: input.toolName,
        args: input.args ?? {},
        ...(input.callId === undefined ? {} : { callId: input.callId }),
      },
    });
  }

  async suspendContinuation(
    sessionId: string,
    input: {
      id?: string;
      wakeCondition: ContinuationWakeCondition;
      suspendedReason: string;
      resumeDirective: string;
    },
  ): Promise<ExecutionContinuation> {
    const body = await this.requestJson<{ continuation: unknown }>(
      `/sessions/${sessionId}/continuations`,
      { method: "POST", body: input },
    );
    return parseExecutionContinuation(body.continuation);
  }

  async getContinuation(sessionId: string): Promise<ExecutionContinuation | null> {
    const body = await this.requestJson<{ continuation: unknown | null }>(
      `/sessions/${sessionId}/continuation`,
    );
    return body.continuation === null ? null : parseExecutionContinuation(body.continuation);
  }

  async claimContinuationResume(
    sessionId: string,
    continuationId: string,
  ): Promise<{ continuation: ExecutionContinuation; snapshot: RuntimeSnapshot }> {
    const body = await this.requestJson<{ continuation: unknown; snapshot: unknown }>(
      `/sessions/${sessionId}/continuations/${continuationId}/resume`,
      { method: "POST", body: {} },
    );
    return {
      continuation: parseExecutionContinuation(body.continuation),
      snapshot: parseRuntimeSnapshot(body.snapshot),
    };
  }

  async completeContinuation(
    sessionId: string,
    continuationId: string,
    attemptId: string,
  ): Promise<ExecutionContinuation> {
    const body = await this.requestJson<{ continuation: unknown }>(
      `/sessions/${sessionId}/continuations/${continuationId}/complete`,
      { method: "POST", body: { attemptId } },
    );
    return parseExecutionContinuation(body.continuation);
  }

  async failContinuationResume(
    sessionId: string,
    continuationId: string,
    attemptId: string,
  ): Promise<ExecutionContinuation> {
    const body = await this.requestJson<{ continuation: unknown }>(
      `/sessions/${sessionId}/continuations/${continuationId}/resume-failed`,
      { method: "POST", body: { attemptId } },
    );
    return parseExecutionContinuation(body.continuation);
  }

  async requestReplan(sessionId: string, mode?: ReplanMode): Promise<RequestReplanResult> {
    const body = await this.requestJson<Record<string, unknown>>(`/sessions/${sessionId}/replans`, {
      method: "POST",
      body: mode === undefined ? {} : { mode },
    });
    if (body.kind === "not_needed") {
      return {
        kind: "not_needed",
        assessment: replanAssessmentSchema.parse(body.assessment),
      };
    }
    return {
      kind: z.enum(["applied", "pending_confirmation", "suggested", "failed"]).parse(body.kind),
      assessment: replanAssessmentSchema.parse(body.assessment),
      affectedSubgraph: affectedSubgraphSchema.parse(body.affectedSubgraph),
      planChange: parsePlanChange(body.planChange),
      state: parseMaterializedState(body.state),
    };
  }

  async confirmPlanPatch(
    sessionId: string,
    patchId: string,
  ): Promise<{
    kind: "applied" | "pending_confirmation" | "failed";
    planChange: PlanChange;
    state: MaterializedExecutionState;
  }> {
    const body = await this.requestJson<{
      kind: string;
      planChange: unknown;
      state: unknown;
    }>(`/sessions/${sessionId}/plan-patches/${patchId}/confirm`, {
      method: "POST",
      body: { confirmed: true },
    });
    return {
      kind: z.enum(["applied", "pending_confirmation", "failed"]).parse(body.kind),
      planChange: parsePlanChange(body.planChange),
      state: parseMaterializedState(body.state),
    };
  }

  async getLatestPlanChange(sessionId: string): Promise<PlanChange | null> {
    const body = await this.requestJson<{ planChange: unknown | null }>(
      `/sessions/${sessionId}/plan-patches/latest`,
    );
    return body.planChange === null ? null : parsePlanChange(body.planChange);
  }

  private async appendBuiltEvent(
    sessionId: string,
    type: Exclude<RuntimeEvent["type"], "domain_event">,
    payload: Record<string, unknown>,
    input: AppendEventInput,
  ): Promise<AppendEventResult> {
    const envelope = await this.buildEnvelope(sessionId, input);
    return this.appendEvent(
      sessionId,
      runtimeEventSchema.parse({
        ...envelope,
        type,
        payload,
      }),
    );
  }

  private async buildEnvelope(
    sessionId: string,
    input: AppendEventInput,
  ): Promise<{
    id: string;
    sessionId: string;
    idempotencyKey: string;
    actorId: string;
    origin: string;
    occurredAt: Date;
  }> {
    const context = await this.getContext();
    const occurredAt =
      input.occurredAt === undefined
        ? new Date()
        : typeof input.occurredAt === "string"
          ? new Date(input.occurredAt)
          : input.occurredAt;

    return {
      id: input.id ?? newId("evt"),
      sessionId,
      idempotencyKey: input.idempotencyKey ?? newId("idem"),
      actorId: input.actorId ?? context.actorId,
      origin: input.origin ?? "user",
      occurredAt,
    };
  }

  private async requestJson<T>(
    path: string,
    init?: { method?: string; body?: unknown; keepalive?: boolean },
  ): Promise<T> {
    const context = await this.getContext();
    const headers: Record<string, string> = {
      [PEAR_CONTEXT_HEADER]: serializePearClientContext(context),
    };

    const method = init?.method ?? "GET";
    const requestInit: RequestInit = {
      method,
      headers,
      ...(init?.keepalive === true ? { keepalive: true } : {}),
    };
    if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
      requestInit.body = JSON.stringify(init.body, (_key, value) => {
        if (value instanceof Date) return value.toISOString();
        return value;
      });
    }

    const response = await this.fetchImpl(joinUrl(this.baseUrl, path), requestInit);

    if (!response.ok) {
      throw await this.toError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async toError(response: Response): Promise<PearClientError> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => undefined);
    }
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `PEAR request failed (${response.status})`;
    return new PearClientError(message, response.status, body);
  }
}
