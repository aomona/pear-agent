import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { AuthorizationError, type AuthorizeFn, type PearOperation } from "../authorize.js";
import {
  PearContextError,
  resolvePearContextFromHeader,
  type PearRequestContext,
} from "../context.js";
import type { PearEnv } from "../env.js";
import { registerContinuationRoutes } from "../continuation/routes.js";
import {
  ContinuationConflictError,
  ContinuationNotFoundError,
  EventIdentityConflictError,
  SessionConflictError,
  SessionNotFoundError,
  VoiceLeaseConflictError,
  VoiceLeaseNotFoundError,
  VoiceTokenUnavailableError,
} from "../errors.js";
import { PlanArtifactConflictError, PlanArtifactNotFoundError } from "../d1/plan-repository.js";
import {
  ClarificationNotFoundError,
  CompileJobConflictError,
  CompileJobNotFoundError,
} from "../d1/compile-repository.js";
import type { PlanGenerator } from "../planner.js";
import { registerPlanRoutes, type PlanLibraryOptions } from "../plans/routes.js";
import { registerReplanRoutes } from "../replan/routes.js";
import type { ReplanRuntime } from "../replan/engine.js";
import { registerSessionRoutes } from "../session/routes.js";
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
   * Per-request PlanGenerator (e.g. needs `env.GEMINI_API_KEY`).
   * When set, used instead of {@link planGenerator} for generate/session paths.
   */
  createPlanGenerator?: (env: PearEnv) => PlanGenerator;
  /**
   * Resolve host authentication into {@link PearRequestContext}.
   * Defaults to parsing the `x-pear-context` header as JSON.
   */
  resolveContext?: (request: Request) => PearRequestContext | Promise<PearRequestContext>;
  /** Max raw upload size in bytes (default 10 MiB). */
  maxRawInputBytes?: number;
  /** Override Gemini Live model id for token minting. */
  geminiLiveModel?: string;
  /** Domain guidance locked into Gemini Live's server-side system instruction. */
  realtimeInstructions?: string;
  /** Preferred locale for Live responses, for example `ja-JP`. */
  realtimeLocale?: string;
  /**
   * Inject token minter (tests). Default: Google GenAI when key present.
   */
  voiceTokenMinter?: VoiceTokenMinter;
  /** Host-injected Assess/Replan runtime, normally backed by AI SDK. */
  replanRuntime?: ReplanRuntime;
  /** Per-request Replan runtime for models/providers that need Worker env bindings. */
  createReplanRuntime?: (env: PearEnv) => ReplanRuntime;
  /**
   * Optional plan-library host hooks (normalize free-text, improve plan).
   * Plan CRUD always uses D1; these only power /plans/:id/normalize|improve.
   */
  planLibrary?: Pick<
    PlanLibraryOptions,
    | "freeTextResolver"
    | "createFreeTextResolver"
    | "planImprover"
    | "createPlanImprover"
    | "validatePlanEdit"
    | "normalizeDomainInput"
    | "resolveDomainFreeTextField"
    | "compileRuntime"
    | "createCompileRuntime"
  >;
};

export type PearApp = Hono<{ Bindings: PearEnv; Variables: PearAppVariables }>;

/**
 * Minimal PEAR Worker HTTP API. Session creation runs the injected PlanGenerator
 * (AI SDK in production) then persists Execution State via the session Agent + D1.
 */
export function createPearApp(options: CreatePearAppOptions): PearApp {
  const resolveContext = options.resolveContext ?? resolvePearContextFromHeader;
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
      error instanceof VoiceTokenUnavailableError ||
      error instanceof ContinuationConflictError ||
      error instanceof ContinuationNotFoundError ||
      error instanceof PlanArtifactNotFoundError ||
      error instanceof PlanArtifactConflictError ||
      error instanceof CompileJobNotFoundError ||
      error instanceof ClarificationNotFoundError ||
      error instanceof CompileJobConflictError
    ) {
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    if (error instanceof z.ZodError) {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: "Internal error" }, 500);
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

  registerSessionRoutes(app, {
    authorize: options.authorize,
    planGenerator: options.planGenerator,
    ...(options.createPlanGenerator !== undefined
      ? { createPlanGenerator: options.createPlanGenerator }
      : {}),
    ...(options.replanRuntime !== undefined ? { replanRuntime: options.replanRuntime } : {}),
    ...(options.createReplanRuntime !== undefined
      ? { createReplanRuntime: options.createReplanRuntime }
      : {}),
    ...(options.maxRawInputBytes !== undefined
      ? { maxRawInputBytes: options.maxRawInputBytes }
      : {}),
  });
  registerVoiceRoutes(app, {
    authorize: options.authorize,
    voiceTokenMinter,
    ...(options.geminiLiveModel === undefined ? {} : { geminiLiveModel: options.geminiLiveModel }),
    ...(options.realtimeInstructions === undefined
      ? {}
      : { realtimeInstructions: options.realtimeInstructions }),
    ...(options.realtimeLocale === undefined ? {} : { realtimeLocale: options.realtimeLocale }),
    requestReplan: async ({ request, env, sessionId, mode }) => {
      const url = new URL(request.url);
      url.pathname = `/sessions/${encodeURIComponent(sessionId)}/replans`;
      url.search = "";
      const response = await app.request(
        url,
        {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({ mode }),
        },
        env,
      );
      const result = (await response.json()) as { message?: string } & Record<string, unknown>;
      if (!response.ok) {
        throw new Error(result.message ?? `Replan request failed (${response.status})`);
      }
      return result;
    },
  });
  registerContinuationRoutes(app, options.authorize);
  registerReplanRoutes(app, options.authorize, options.replanRuntime, options.createReplanRuntime);
  registerPlanRoutes(app, {
    authorize: options.authorize,
    planGenerator: options.planGenerator,
    ...(options.createPlanGenerator !== undefined
      ? { createPlanGenerator: options.createPlanGenerator }
      : {}),
    ...options.planLibrary,
  });

  return app;
}

// Re-export for hosts that inject the stub minter in tests.
export { stubVoiceTokenMinter };

// Keep PearOperation exported usage visible for hosts reading route shapes.
export type { PearOperation };
