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
import {
  AuthorizationError,
  runAuthorize,
  type AuthorizeFn,
  type PearOperation,
} from "../authorize.js";
import {
  PearContextError,
  resolvePearContextFromHeader,
  type PearRequestContext,
} from "../context.js";
import type { PearEnv } from "../env.js";
import type { PlanGenerator } from "../planner.js";
import { DEFAULT_MAX_RAW_INPUT_BYTES, R2RawInputStore } from "../r2/raw-input-store.js";
import { parseRuntimeEvent, reviveJsonDates, serializeJson } from "../serialize.js";
import { buildInitialExecutionState } from "../session/build-initial-state.js";

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
  const app = new Hono<{ Bindings: PearEnv; Variables: PearAppVariables }>();

  app.onError((error, c) => {
    if (error instanceof AuthorizationError) {
      return c.json({ error: error.message }, 403);
    }
    if (error instanceof PearContextError) {
      return c.json({ error: error.message }, 401);
    }
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    if (error instanceof z.ZodError) {
      return c.json({ error: error.message }, 400);
    }
    const message = error instanceof Error ? error.message : "Internal error";
    const status = message.startsWith("Unknown execution session")
      ? 404
      : message.includes("already exists")
        ? 409
        : 500;
    return c.json({ error: message }, status);
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
    // Revive Core goal dates only — leave Domain normalizedInput as JSON-safe values.
    const goal = executionGoalSchema.parse(reviveJsonDates(raw.goal));
    const body = { ...raw, goal };

    await authorize(options.authorize, { type: "session.create", domainId: body.domainId }, context);

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
        session: JSON.parse(serializeJson(initialState.session)),
        plan: JSON.parse(serializeJson(initialState.plan)),
        stepStates: JSON.parse(serializeJson(initialState.stepStates)),
      },
      201,
    );
  });

  app.get("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize(options.authorize, { type: "session.read", sessionId }, context);
    const state = await agentGetState(c.env, sessionId);
    if (!state) throw new HTTPException(404, { message: `Unknown execution session: ${sessionId}` });
    return c.json({ state: JSON.parse(serializeJson(state)) });
  });

  app.get("/sessions/:sessionId/snapshot", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize(options.authorize, { type: "session.read", sessionId }, context);

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
    if (!snapshot) {
      throw new HTTPException(404, { message: `Unknown execution session: ${sessionId}` });
    }
    return c.json({ snapshot: JSON.parse(serializeJson(snapshot)) });
  });

  app.post("/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    const event = parseRuntimeEvent(JSON.stringify(await c.req.json()));
    if (event.sessionId !== sessionId) {
      throw new HTTPException(400, { message: "event.sessionId must match path sessionId" });
    }
    await authorize(
      options.authorize,
      { type: "session.appendEvent", sessionId, eventType: event.type },
      context,
    );
    const result = await agentAppendEvent(c.env, event);
    return c.json({
      kind: result.kind,
      event: JSON.parse(serializeJson(result.event)),
      state: JSON.parse(serializeJson(result.state)),
    });
  });

  app.post("/sessions/:sessionId/raw-inputs", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize(options.authorize, { type: "rawInput.put", sessionId }, context);

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
    if (body.byteLength > maxRawInputBytes) {
      throw new HTTPException(413, {
        message: `Raw input exceeds max size of ${maxRawInputBytes} bytes`,
      });
    }

    const metadata = await store.put({
      sessionId,
      actorId: context.actorId,
      body,
      contentType: file.type || null,
    });

    return c.json({ rawInput: serializeRawInputMetadata(metadata) }, 201);
  });

  app.get("/sessions/:sessionId/raw-inputs/:inputId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const inputId = c.req.param("inputId");
    const context = c.get("pearContext");
    await authorize(options.authorize, { type: "rawInput.read", sessionId, inputId }, context);

    const store = new R2RawInputStore(c.env.RAW_INPUTS, c.env.DB);
    const metadata = await store.getMetadata(sessionId, inputId);
    if (!metadata) throw new HTTPException(404, { message: "Raw input not found" });
    return c.json({ rawInput: serializeRawInputMetadata(metadata) });
  });

  app.put("/sessions/:sessionId/normalized-input", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize(options.authorize, { type: "normalizedInput.write", sessionId }, context);
    const payload = await c.req.json();
    await agentPutNormalizedInput(c.env, sessionId, payload);
    return c.json({ ok: true });
  });

  app.get("/sessions/:sessionId/normalized-input", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize(options.authorize, { type: "normalizedInput.read", sessionId }, context);
    const payload = await agentGetNormalizedInput(c.env, sessionId);
    if (payload === undefined) {
      throw new HTTPException(404, { message: "Normalized input not found" });
    }
    return c.json({ normalizedInput: payload });
  });

  return app;
}

async function authorize(
  authorizeFn: AuthorizeFn,
  operation: PearOperation,
  context: PearRequestContext,
): Promise<void> {
  await runAuthorize(authorizeFn, operation, context);
}

function serializeRawInputMetadata(metadata: {
  id: string;
  sessionId: string;
  objectKey: string;
  contentType: string | null;
  byteSize: number;
  checksumSha256: string;
  createdAt: Date;
  createdByActorId: string;
}) {
  return {
    id: metadata.id,
    sessionId: metadata.sessionId,
    objectKey: metadata.objectKey,
    contentType: metadata.contentType,
    byteSize: metadata.byteSize,
    checksumSha256: metadata.checksumSha256,
    createdAt: metadata.createdAt.toISOString(),
    createdByActorId: metadata.createdByActorId,
  };
}
