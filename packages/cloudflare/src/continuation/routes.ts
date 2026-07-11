import { continuationWakeConditionSchema } from "@pear-agent/core";
import type { Hono } from "hono";
import { z } from "zod";

import {
  agentClaimContinuationResume,
  agentCompleteContinuation,
  agentGetContinuation,
  agentFailContinuationResume,
  agentSuspendContinuation,
} from "../agent/client.js";
import type { AuthorizeFn } from "../authorize.js";
import type { PearRequestContext } from "../context.js";
import type { PearEnv } from "../env.js";
import { ContinuationConflictError, ContinuationNotFoundError } from "../errors.js";
import { toJsonValue } from "../serialize.js";

type ContinuationHono = Hono<{
  Bindings: PearEnv;
  Variables: { pearContext: PearRequestContext };
}>;

const suspendBodySchema = z.object({
  id: z.string().min(1).optional(),
  wakeCondition: continuationWakeConditionSchema,
  suspendedReason: z.string().min(1),
  resumeDirective: z.string().min(1),
});
const resumeAttemptBodySchema = z.object({ attemptId: z.string().min(1) });

export function registerContinuationRoutes(app: ContinuationHono, authorize: AuthorizeFn): void {
  app.post("/sessions/:sessionId/continuations", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize({ type: "continuation.suspend", sessionId }, context);
    const body = suspendBodySchema.parse(await c.req.json());
    const continuation = await agentSuspendContinuation(c.env, sessionId, {
      actorId: context.actorId,
      wakeCondition: body.wakeCondition,
      suspendedReason: body.suspendedReason,
      resumeDirective: body.resumeDirective,
      ...(body.id === undefined ? {} : { id: body.id }),
    });
    return c.json({ continuation: toJsonValue(continuation) }, 201);
  });

  app.get("/sessions/:sessionId/continuation", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize({ type: "continuation.read", sessionId }, context);
    const continuation = await agentGetContinuation(c.env, sessionId);
    return c.json({ continuation: continuation ? toJsonValue(continuation) : null });
  });

  app.post("/sessions/:sessionId/continuations/:continuationId/resume", async (c) => {
    const sessionId = c.req.param("sessionId");
    const continuationId = c.req.param("continuationId");
    const context = c.get("pearContext");
    await authorize({ type: "continuation.resume", sessionId, continuationId }, context);
    const result = await agentClaimContinuationResume(c.env, sessionId, {
      continuationId,
      actorId: context.actorId,
    });
    if (!result.ok) {
      if (result.code === "not_found") throw new ContinuationNotFoundError(continuationId);
      throw new ContinuationConflictError(sessionId);
    }
    return c.json({
      continuation: toJsonValue(result.continuation),
      snapshot: toJsonValue(result.snapshot),
    });
  });

  app.post("/sessions/:sessionId/continuations/:continuationId/complete", async (c) => {
    const sessionId = c.req.param("sessionId");
    const continuationId = c.req.param("continuationId");
    const context = c.get("pearContext");
    await authorize({ type: "continuation.complete", sessionId, continuationId }, context);
    const body = resumeAttemptBodySchema.parse(await c.req.json());
    const continuation = await agentCompleteContinuation(
      c.env,
      sessionId,
      {
        continuationId,
        actorId: context.actorId,
      },
      body.attemptId,
    );
    if (!continuation) throw new ContinuationConflictError(sessionId);
    return c.json({ continuation: toJsonValue(continuation) });
  });

  app.post("/sessions/:sessionId/continuations/:continuationId/resume-failed", async (c) => {
    const sessionId = c.req.param("sessionId");
    const continuationId = c.req.param("continuationId");
    const context = c.get("pearContext");
    await authorize({ type: "continuation.failResume", sessionId, continuationId }, context);
    const body = resumeAttemptBodySchema.parse(await c.req.json());
    const continuation = await agentFailContinuationResume(
      c.env,
      sessionId,
      {
        continuationId,
        actorId: context.actorId,
      },
      body.attemptId,
    );
    if (!continuation) throw new ContinuationConflictError(sessionId);
    return c.json({ continuation: toJsonValue(continuation) });
  });
}
