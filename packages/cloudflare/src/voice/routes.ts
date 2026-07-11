import type { Hono } from "hono";
import { z } from "zod";

import {
  agentAcquireVoiceLease,
  agentAppendEvent,
  agentGetSnapshot,
  agentGetVoiceLease,
  agentReleaseVoiceLease,
  agentSetVoiceResumeHandle,
} from "../agent/client.js";
import type { AuthorizeFn } from "../authorize.js";
import type { PearRequestContext } from "../context.js";
import type { PearEnv } from "../env.js";
import {
  SessionNotFoundError,
  VoiceLeaseConflictError,
  VoiceLeaseNotFoundError,
  VoiceTokenUnavailableError,
} from "../errors.js";
import { toJsonValue } from "../serialize.js";
import type { VoiceLeaseResult } from "./results.js";
import type { VoiceTokenMinter } from "./token.js";
import { executeVoiceTool, voiceToolAuthorizeEventType } from "./tools.js";

type VoiceHono = Hono<{
  Bindings: PearEnv;
  Variables: { pearContext: PearRequestContext };
}>;

export type RegisterVoiceRoutesOptions = {
  authorize: AuthorizeFn;
  voiceTokenMinter: VoiceTokenMinter;
  geminiLiveModel?: string;
};

function unwrapLease(sessionId: string, result: VoiceLeaseResult) {
  if (result.ok) return result.lease;
  if (result.code === "conflict") {
    throw new VoiceLeaseConflictError(sessionId, result.holderActorId);
  }
  if (result.code === "session_not_found") {
    throw new SessionNotFoundError(sessionId);
  }
  throw new VoiceLeaseNotFoundError(sessionId);
}

/**
 * Voice Lease / token / tool bridge routes (Issue #6).
 * Lease mutations use Agent Result types (no custom Error across DO RPC).
 */
export function registerVoiceRoutes(app: VoiceHono, options: RegisterVoiceRoutesOptions): void {
  const { authorize, voiceTokenMinter } = options;

  app.post("/sessions/:sessionId/voice/lease", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize({ type: "voice.lease.acquire", sessionId }, context);

    let body: { ttlMs?: number; leaseId?: string } = {};
    try {
      body = (await c.req.json()) as { ttlMs?: number; leaseId?: string };
    } catch {
      body = {};
    }

    const result = await agentAcquireVoiceLease(c.env, sessionId, {
      actorId: context.actorId,
      ...(body.leaseId === undefined ? {} : { leaseId: body.leaseId }),
      ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
    });
    const lease = unwrapLease(sessionId, result);
    return c.json({ lease: toJsonValue(lease) }, 201);
  });

  app.get("/sessions/:sessionId/voice/lease", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize({ type: "voice.lease.read", sessionId }, context);
    const lease = await agentGetVoiceLease(c.env, sessionId);
    return c.json({ lease: lease ? toJsonValue(lease) : null });
  });

  app.delete("/sessions/:sessionId/voice/lease", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize({ type: "voice.lease.release", sessionId }, context);
    const result = await agentReleaseVoiceLease(c.env, sessionId, {
      actorId: context.actorId,
    });
    const lease = unwrapLease(sessionId, result);
    return c.json({ lease: toJsonValue(lease) });
  });

  app.put("/sessions/:sessionId/voice/resume-handle", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize({ type: "voice.resumeHandle.write", sessionId }, context);
    const body = z.object({ handle: z.string().nullable() }).parse(await c.req.json());
    const result = await agentSetVoiceResumeHandle(c.env, sessionId, {
      actorId: context.actorId,
      handle: body.handle,
    });
    const lease = unwrapLease(sessionId, result);
    return c.json({ lease: toJsonValue(lease) });
  });

  app.post("/sessions/:sessionId/voice/token", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize({ type: "voice.token", sessionId }, context);

    const lease = await agentGetVoiceLease(c.env, sessionId);
    if (!lease || lease.actorId !== context.actorId) {
      throw new VoiceLeaseNotFoundError(sessionId);
    }

    const snapshot = await agentGetSnapshot(c.env, sessionId);
    if (!snapshot) throw new SessionNotFoundError(sessionId);

    try {
      const minted = await voiceTokenMinter({
        apiKey: c.env.GEMINI_API_KEY,
        snapshot,
        lease,
        ...(options.geminiLiveModel === undefined ? {} : { model: options.geminiLiveModel }),
      });
      return c.json({ token: minted.token, model: minted.model });
    } catch (caught) {
      if (caught instanceof VoiceTokenUnavailableError) throw caught;
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new VoiceTokenUnavailableError(message);
    }
  });

  app.post("/sessions/:sessionId/voice/tools", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    const body = z
      .object({
        toolName: z.string().min(1),
        args: z.record(z.string(), z.unknown()).default({}),
        callId: z.string().min(1).optional(),
      })
      .parse(await c.req.json());

    await authorize({ type: "voice.tool", sessionId, toolName: body.toolName }, context);

    const lease = await agentGetVoiceLease(c.env, sessionId);
    if (!lease || lease.actorId !== context.actorId) {
      throw new VoiceLeaseNotFoundError(sessionId);
    }

    // Same vocabulary as HTTP events: Core RuntimeEvent.type (not tool name).
    const eventType = voiceToolAuthorizeEventType(body.toolName);
    if (eventType === undefined) {
      return c.json(
        {
          callId: body.callId ?? null,
          toolName: body.toolName,
          ok: false,
          error: true,
          message: `Unknown voice tool: ${body.toolName}`,
        },
        400,
      );
    }
    if (eventType !== null) {
      await authorize({ type: "session.appendEvent", sessionId, eventType }, context);
    }

    const toolResult = await executeVoiceTool(body.toolName, body.args, {
      sessionId,
      actorId: context.actorId,
      ...(body.callId === undefined ? {} : { callId: body.callId }),
      getSnapshot: async () => {
        const snapshot = await agentGetSnapshot(c.env, sessionId);
        if (!snapshot) throw new SessionNotFoundError(sessionId);
        return snapshot;
      },
      appendEvent: (event) => agentAppendEvent(c.env, event),
    });

    return c.json({
      callId: body.callId ?? null,
      toolName: body.toolName,
      ...toolResult,
    });
  });
}
