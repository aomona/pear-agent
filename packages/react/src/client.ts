import {
  type AppendEventResult,
  type MaterializedExecutionState,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "@pear-agent/core";

import { PearClientError } from "./errors.js";
import { parseAppendEventResult, parseMaterializedState, parseRuntimeSnapshot } from "./parse.js";
import type {
  AppendEventInput,
  CreateSessionInput,
  CreateSessionResult,
  DomainEventInput,
  PearClientContext,
  StepActionInput,
  TimerActionInput,
  TimerStartInput,
} from "./types.js";

const CONTEXT_HEADER = "x-pear-context";

export type PearClientOptions = {
  /** Worker origin, e.g. `https://my-worker.example.workers.dev` or `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** Host resolves auth into PEAR context for each request. */
  getContext: () => PearClientContext | Promise<PearClientContext>;
  fetch?: typeof fetch;
};

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
 * Does not open WebSockets; realtime is handled by hooks + `agents/react`.
 */
export class PearClient {
  readonly baseUrl: string;
  private readonly getContext: PearClientOptions["getContext"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: PearClientOptions) {
    this.baseUrl = options.baseUrl;
    this.getContext = options.getContext;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async health(): Promise<{ ok: true }> {
    const response = await this.fetchImpl(joinUrl(this.baseUrl, "/health"));
    if (!response.ok) {
      throw await this.toError(response);
    }
    return (await response.json()) as { ok: true };
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const body = await this.requestJson<CreateSessionResult>("/sessions", {
      method: "POST",
      body: input,
    });
    return body;
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

  // --- Typed convenience actions (build RuntimeEvents) ---

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
    return this.appendEvent(sessionId, {
      ...envelope,
      type: "domain_event",
      domainType: input.domainType,
      payload: input.payload as never,
    });
  }

  private async appendBuiltEvent(
    sessionId: string,
    type: RuntimeEvent["type"],
    payload: Record<string, unknown>,
    input: AppendEventInput,
  ): Promise<AppendEventResult> {
    const envelope = await this.buildEnvelope(sessionId, input);
    return this.appendEvent(sessionId, {
      ...envelope,
      type,
      payload,
    } as RuntimeEvent);
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
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const context = await this.getContext();
    const headers: Record<string, string> = {
      [CONTEXT_HEADER]: JSON.stringify({
        actorId: context.actorId,
        roles: context.roles ?? [],
        claims: context.claims ?? {},
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      }),
    };

    const method = init?.method ?? "GET";
    const requestInit: RequestInit = { method, headers };
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
