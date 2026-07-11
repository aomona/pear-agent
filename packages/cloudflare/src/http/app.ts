import { executionGoalSchema } from "@pear-agent/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import {
  agentAppendEvent,
  agentCreateSession,
  agentGetNormalizedInput,
  agentGetSnapshot,
  agentGetState,
  agentPutNormalizedInput,
} from "../agent/client.js";
import { AuthorizationError, type AuthorizeFn, type PearOperation } from "../authorize.js";
import {
  PearContextError,
  resolvePearContextFromHeader,
  type PearRequestContext,
} from "../context.js";
import type { PearEnv } from "../env.js";
import {
  EventIdentityConflictError,
  SessionConflictError,
  SessionNotFoundError,
  VoiceLeaseConflictError,
  VoiceLeaseNotFoundError,
  VoiceTokenUnavailableError,
} from "../errors.js";
import type { PlanGenerator } from "../planner.js";
import { DEFAULT_MAX_RAW_INPUT_BYTES, R2RawInputStore } from "../r2/raw-input-store.js";
import { parseRuntimeEventValue, toJsonValue } from "../serialize.js";
import { buildInitialExecutionState } from "../session/build-initial-state.js";
import { registerVoiceRoutes } from "../voice/routes.js";
import {
  createGoogleGenaiTokenMinter,
  stubVoiceTokenMinter,
  type VoiceTokenMinter,
} from "../voice/token.js";

export type PearAppVariables = {
  pearContext: PearRequestContext;
};

export type CreatePearAppOptions = {
  authorize: AuthorizeFn;
  planGenerator: PlanGenerator;
  /**
   * Resolve host authentication into {@link PearRequestContext}.
   * Defaults to parsing the `x-pear-context` header as JSON.
   */
  resolveContext?: (request: Request) => PearRequestContext | Promise<PearRequestContext>;
  /** Max raw upload size in bytes (default 10 MiB). */
  maxRawInputBytes?: number;
  /** Override Gemini Live model id for token minting. */
  geminiLiveModel?: string;
  /**
   * Inject token minter (tests). Default: Google GenAI when key present.
   */
  voiceTokenMinter?: VoiceTokenMinter;
};

/** Raw JSON body — Domain `normalizedInput` is left un-revived. */
const createSessionBodySchema = z.object({
  sessionId: z.string().min(1).optional(),
  domainId: z.string().min(1),
  actorIds: z.array(z.string().min(1)).min(1),
  goal: z.unknown(),
  normalizedInput: z.unknown(),
});

export type PearApp = Hono<{ Bindings: PearEnv; Variables: PearAppVariables }>;

/**
 * Minimal PEAR Worker HTTP API. Session creation runs the injected PlanGenerator
 * (AI SDK in production) then persists Execution State via the session Agent + D1.
 */
export function createPearApp(options: CreatePearAppOptions): PearApp {
  const resolveContext = options.resolveContext ?? resolvePearContextFromHeader;
  const maxRawInputBytes = options.maxRawInputBytes ?? DEFAULT_MAX_RAW_INPUT_BYTES;
  const voiceTokenMinter = options.voiceTokenMinter ?? createGoogleGenaiTokenMinter();
  const app = new Hono<{ Bindings: PearEnv; Variables: PearAppVariables }>();

  app.onError((error, c) => {
    if (
      error instanceof AuthorizationError ||
      error instanceof PearContextError ||
      error instanceof SessionNotFoundError ||
      error instanceof SessionConflictError ||
      error instanceof EventIdentityConflictError ||
      error instanceof VoiceLeaseConflictError ||
      error instanceof VoiceLeaseNotFoundError ||
      error instanceof VoiceTokenUnavailableError
    ) {
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    if (error instanceof z.ZodError) {
      return c.json({ error: error.message }, 400);
    }
    const message = error instanceof Error ? error.message : "Internal error";
    return c.json({ error: message }, 500);
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    const context = await resolveContext(c.req.raw);
    c.set("pearContext", context);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/sessions", async (c) => {
    const context = c.get("pearContext");
    const raw = createSessionBodySchema.parse(await c.req.json());
    // Core goal dates coerce via dateSchema; Domain normalizedInput stays JSON-safe.
    const goal = executionGoalSchema.parse(raw.goal);
    const body = { ...raw, goal };

    await options.authorize({ type: "session.create", domainId: body.domainId }, context);

    const sessionId = body.sessionId ?? crypto.randomUUID();
    const plan = await options.planGenerator.generatePlan({
      domainId: body.domainId,
      goal: body.goal,
      normalizedInput: body.normalizedInput,
      context,
    });

    if (plan.goal.id !== body.goal.id) {
      throw new HTTPException(400, {
        message: "Planner goal id must match the requested goal id",
      });
    }

    const initialState = buildInitialExecutionState({
      sessionId,
      plan,
      actorIds: body.actorIds,
    });

    await agentCreateSession(c.env, {
      sessionId,
      domainId: body.domainId,
      initialState,
      normalizedInput: body.normalizedInput,
    });

    return c.json(
      {
        sessionId,
        session: toJsonValue(initialState.session),
        plan: toJsonValue(initialState.plan),
        stepStates: toJsonValue(initialState.stepStates),
      },
      201,
    );
  });

  app.get("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await options.authorize({ type: "session.read", sessionId }, context);
    const state = await agentGetState(c.env, sessionId);
    if (!state) throw new SessionNotFoundError(sessionId);
    return c.json({ state: toJsonValue(state) });
  });

  app.get("/sessions/:sessionId/snapshot", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await options.authorize({ type: "session.read", sessionId }, context);

    const limitParam = c.req.query("recentEventLimit");
    let recentEventLimit: number | undefined;
    if (limitParam !== undefined) {
      if (!/^\d+$/.test(limitParam)) {
        throw new HTTPException(400, {
          message: "recentEventLimit must be a non-negative integer",
        });
      }
      recentEventLimit = Number.parseInt(limitParam, 10);
    }

    const snapshot = await agentGetSnapshot(
      c.env,
      sessionId,
      recentEventLimit === undefined ? undefined : { recentEventLimit },
    );
    if (!snapshot) throw new SessionNotFoundError(sessionId);
    return c.json({ snapshot: toJsonValue(snapshot) });
  });

  app.post("/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    const event = parseRuntimeEventValue(await c.req.json());
    if (event.sessionId !== sessionId) {
      throw new HTTPException(400, { message: "event.sessionId must match path sessionId" });
    }
    await options.authorize(
      { type: "session.appendEvent", sessionId, eventType: event.type },
      context,
    );
    const result = await agentAppendEvent(c.env, event);
    return c.json({
      kind: result.kind,
      event: toJsonValue(result.event),
      state: toJsonValue(result.state),
    });
  });

  app.post("/sessions/:sessionId/raw-inputs", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await options.authorize({ type: "rawInput.put", sessionId }, context);

    const form = await c.req.formData();
    const file = form.get("file") ?? form.get("raw");
    if (!(file instanceof File)) {
      throw new HTTPException(400, {
        message: 'multipart field "file" (or "raw") is required',
      });
    }

    if (file.size > maxRawInputBytes) {
      throw new HTTPException(413, {
        message: `Raw input exceeds max size of ${maxRawInputBytes} bytes`,
      });
    }

    const store = new R2RawInputStore(c.env.RAW_INPUTS, c.env.DB);
    const body = await file.arrayBuffer();
    const metadata = await store.put({
      sessionId,
      actorId: context.actorId,
      body,
      contentType: file.type || null,
    });

    return c.json({ rawInput: toJsonValue(metadata) }, 201);
  });

  app.get("/sessions/:sessionId/raw-inputs/:inputId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const inputId = c.req.param("inputId");
    const context = c.get("pearContext");
    await options.authorize({ type: "rawInput.read", sessionId, inputId }, context);

    const store = new R2RawInputStore(c.env.RAW_INPUTS, c.env.DB);
    const metadata = await store.getMetadata(sessionId, inputId);
    if (!metadata) throw new HTTPException(404, { message: "Raw input not found" });
    return c.json({ rawInput: toJsonValue(metadata) });
  });

  app.put("/sessions/:sessionId/normalized-input", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await options.authorize({ type: "normalizedInput.write", sessionId }, context);
    const payload = await c.req.json();
    await agentPutNormalizedInput(c.env, sessionId, payload);
    return c.json({ ok: true });
  });

  app.get("/sessions/:sessionId/normalized-input", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await options.authorize({ type: "normalizedInput.read", sessionId }, context);
    const payload = await agentGetNormalizedInput(c.env, sessionId);
    if (payload === undefined) {
      throw new HTTPException(404, { message: "Normalized input not found" });
    }
    return c.json({ normalizedInput: payload });
  });

  registerVoiceRoutes(app, {
    authorize: options.authorize,
    voiceTokenMinter,
    ...(options.geminiLiveModel === undefined ? {} : { geminiLiveModel: options.geminiLiveModel }),
  });

  return app;
}

// Re-export for hosts that inject the stub minter in tests.
export { stubVoiceTokenMinter };

// Keep PearOperation exported usage visible for hosts reading route shapes.
export type { PearOperation };
