import {
  executionGoalSchema,
  executionPlanSchema,
  planArtifactStatusSchema,
  type ExecutionPlan,
  type FreeTextFieldResolver,
  type PlanImprover,
} from "@pear-agent/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AuthorizeFn } from "../authorize.js";
import {
  D1PlanRepository,
  PlanArtifactConflictError,
  PlanArtifactNotFoundError,
  type StoredPlanArtifact,
} from "../d1/plan-repository.js";
import type { PearApp } from "../http/app.js";
import type { PlanGenerator } from "../planner.js";
import { toJsonValue } from "../serialize.js";

const planSchema = executionPlanSchema(z.unknown());

export type PlanLibraryOptions = {
  authorize: AuthorizeFn;
  planGenerator: PlanGenerator;
  /**
   * Optional host free-text resolver (often LLM). Used by POST .../normalize when provided.
   * Prefer {@link createFreeTextResolver} when the implementation needs Worker env (API keys).
   */
  freeTextResolver?: FreeTextFieldResolver;
  createFreeTextResolver?: (env: { GEMINI_API_KEY?: string }) => FreeTextFieldResolver | undefined;
  /**
   * Optional host plan improver. Used by POST .../improve when provided.
   */
  planImprover?: PlanImprover;
  createPlanImprover?: (env: { GEMINI_API_KEY?: string }) => PlanImprover | undefined;
  /**
   * Domain-specific normalize. Hosts inject for domains they support.
   * If omitted, POST .../normalize returns 501.
   */
  normalizeDomainInput?: (input: {
    domainId: string;
    input: unknown;
    freeTextResolver?: FreeTextFieldResolver;
    context: unknown;
  }) => Promise<unknown>;
  /**
   * Resolve a single free-text field (e.g. modal "Add" for one belonging).
   * Hosts typically run deterministic parse then freeTextResolver (LLM).
   */
  resolveDomainFreeTextField?: (input: {
    domainId: string;
    field: string;
    freeText: string;
    freeTextResolver?: FreeTextFieldResolver;
    context: unknown;
  }) => Promise<unknown>;
};

function resolveFreeTextResolver(
  options: PlanLibraryOptions,
  env: { GEMINI_API_KEY?: string },
): FreeTextFieldResolver | undefined {
  return options.createFreeTextResolver?.(env) ?? options.freeTextResolver;
}

function resolvePlanImprover(
  options: PlanLibraryOptions,
  env: { GEMINI_API_KEY?: string },
): PlanImprover | undefined {
  return options.createPlanImprover?.(env) ?? options.planImprover;
}

function asHttpError(error: unknown): never {
  if (error instanceof HTTPException) throw error;
  if (
    error instanceof Error &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    const status = (error as { status: number }).status;
    if (status === 400 || status === 502 || status === 503) {
      throw new HTTPException(status, { message: error.message });
    }
  }
  throw error;
}

function repo(env: { DB: D1Database }): D1PlanRepository {
  return new D1PlanRepository(env.DB);
}

function artifactJson(stored: StoredPlanArtifact) {
  return {
    artifact: toJsonValue({
      id: stored.id,
      domainId: stored.domainId,
      status: stored.status,
      title: stored.title,
      goal: stored.goal,
      currentPlan: stored.currentPlan,
      version: stored.version,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      normalizedInput: stored.normalizedInput,
      ownerActorId: stored.ownerActorId,
    }),
  };
}

/**
 * Session-independent plan library HTTP API (CE-11).
 */
export function registerPlanRoutes(app: PearApp, options: PlanLibraryOptions): void {
  app.get("/plans", async (c) => {
    const context = c.get("pearContext");
    await options.authorize({ type: "plan.list" }, context);

    const domainId = c.req.query("domainId");
    const statusRaw = c.req.query("status");
    let status: z.infer<typeof planArtifactStatusSchema> | undefined;
    if (statusRaw !== undefined) {
      status = planArtifactStatusSchema.parse(statusRaw);
    }

    const list = await repo(c.env).listStored({
      ...(domainId !== undefined ? { domainId } : {}),
      ...(status !== undefined ? { status } : {}),
    });

    return c.json({
      plans: list.map((stored) =>
        toJsonValue({
          id: stored.id,
          domainId: stored.domainId,
          status: stored.status,
          title: stored.title,
          version: stored.version,
          goalId: stored.goal.id,
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
        }),
      ),
    });
  });

  app.post("/plans", async (c) => {
    const context = c.get("pearContext");
    const body = z
      .object({
        id: z.string().min(1).optional(),
        domainId: z.string().min(1),
        goal: z.unknown(),
        title: z.string().min(1).max(160).optional(),
        /** Optional full plan; otherwise an empty-step draft is created. */
        plan: z.unknown().optional(),
        status: planArtifactStatusSchema.optional(),
        normalizedInput: z.unknown().optional(),
      })
      .parse(await c.req.json());

    await options.authorize({ type: "plan.create", domainId: body.domainId }, context);

    const goal = executionGoalSchema.parse(body.goal);
    const repository = repo(c.env);

    let stored: StoredPlanArtifact;
    if (body.plan !== undefined) {
      const plan = planSchema.parse(body.plan);
      stored = await repository.createStored({
        ...(body.id !== undefined ? { id: body.id } : {}),
        domainId: body.domainId,
        plan,
        status: body.status ?? "draft",
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.normalizedInput !== undefined ? { normalizedInput: body.normalizedInput } : {}),
        ownerActorId: context.actorId,
      });
    } else {
      stored = await repository.createDraft({
        ...(body.id !== undefined ? { id: body.id } : {}),
        domainId: body.domainId,
        goal,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ownerActorId: context.actorId,
      });
      if (body.normalizedInput !== undefined) {
        stored = await repository.updateMeta({
          artifactId: stored.id,
          normalizedInput: body.normalizedInput,
        });
      }
    }

    return c.json(artifactJson(stored), 201);
  });

  app.get("/plans/:planId", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await options.authorize({ type: "plan.read", planId }, context);

    const stored = await repo(c.env).getStored(planId);
    if (!stored) throw new PlanArtifactNotFoundError(planId);
    return c.json(artifactJson(stored));
  });

  app.patch("/plans/:planId", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await options.authorize({ type: "plan.update", planId }, context);

    const body = z
      .object({
        title: z.string().min(1).max(160).nullable().optional(),
        status: planArtifactStatusSchema.optional(),
        normalizedInput: z.unknown().optional(),
        /** Replace plan body (increments version, changeReason user_edit). */
        plan: z.unknown().optional(),
        summary: z.string().min(1).max(2_000).optional(),
      })
      .parse(await c.req.json());

    const repository = repo(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);

    if (body.plan !== undefined) {
      const nextPlan = planSchema.parse(body.plan) as ExecutionPlan;
      const versioned: ExecutionPlan = {
        ...nextPlan,
        version: existing.version + 1,
        ...(body.title !== undefined && body.title !== null ? { title: body.title } : {}),
      };
      const stored = await repository.saveVersionStored({
        artifactId: planId,
        plan: versioned,
        changeReason: "user_edit",
        ...(body.summary !== undefined ? { summary: body.summary } : { summary: "User edit" }),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.normalizedInput !== undefined ? { normalizedInput: body.normalizedInput } : {}),
      });
      return c.json(artifactJson(stored));
    }

    const stored = await repository.updateMeta({
      artifactId: planId,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.normalizedInput !== undefined ? { normalizedInput: body.normalizedInput } : {}),
    });
    return c.json(artifactJson(stored));
  });

  app.post("/plans/:planId/generate", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await options.authorize({ type: "plan.update", planId }, context);

    const body = z
      .object({
        /** Override stored normalized input for this generation. */
        normalizedInput: z.unknown().optional(),
        goal: z.unknown().optional(),
      })
      .parse((await c.req.json().catch(() => ({}))) as unknown);

    const repository = repo(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);

    const normalizedInput = body.normalizedInput ?? existing.normalizedInput;
    if (normalizedInput === undefined) {
      throw new HTTPException(400, {
        message: "normalizedInput is required (store on artifact or pass in body)",
      });
    }

    const goal = body.goal !== undefined ? executionGoalSchema.parse(body.goal) : existing.goal;

    const generated = await options.planGenerator.generatePlan({
      domainId: existing.domainId,
      goal,
      normalizedInput,
      context,
    });

    if (generated.goal.id !== goal.id) {
      throw new HTTPException(400, {
        message: "Planner goal id must match the artifact goal id",
      });
    }

    // Always bump version (including first generate after empty draft shell).
    const plan: ExecutionPlan = {
      ...generated,
      version: existing.version + 1,
      id: existing.currentPlan.id,
    };

    const stored = await repository.saveVersionStored({
      artifactId: planId,
      plan,
      changeReason: "initial",
      summary: existing.currentPlan.steps.length === 0 ? "Generated plan" : "Regenerated plan",
      normalizedInput,
    });
    return c.json(artifactJson(stored));
  });

  /**
   * Structure one free-text field without writing the full artifact normalizedInput.
   * Intended for UI "add item" modals (structure happens on confirm, not while typing).
   */
  app.post("/plans/:planId/resolve-field", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await options.authorize({ type: "plan.update", planId }, context);

    if (!options.resolveDomainFreeTextField) {
      throw new HTTPException(501, {
        message: "resolveDomainFreeTextField is not configured on this Worker",
      });
    }

    const body = z
      .object({
        field: z.string().min(1),
        freeText: z.string().trim().min(1).max(4_000),
      })
      .parse(await c.req.json());

    const repository = repo(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);

    const freeTextResolver = resolveFreeTextResolver(options, c.env);
    const resolveInput: {
      domainId: string;
      field: string;
      freeText: string;
      freeTextResolver?: FreeTextFieldResolver;
      context: unknown;
    } = {
      domainId: existing.domainId,
      field: body.field,
      freeText: body.freeText,
      context,
    };
    if (freeTextResolver !== undefined) {
      resolveInput.freeTextResolver = freeTextResolver;
    }

    try {
      const value = await options.resolveDomainFreeTextField(resolveInput);
      return c.json({ field: body.field, value });
    } catch (error) {
      asHttpError(error);
    }
  });

  app.post("/plans/:planId/normalize", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await options.authorize({ type: "plan.update", planId }, context);

    if (!options.normalizeDomainInput) {
      throw new HTTPException(501, {
        message: "normalizeDomainInput is not configured on this Worker",
      });
    }

    const body = z
      .object({
        input: z.unknown(),
      })
      .parse(await c.req.json());

    const repository = repo(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);

    const freeTextResolver = resolveFreeTextResolver(options, c.env);
    const resolveInput: {
      domainId: string;
      input: unknown;
      freeTextResolver?: FreeTextFieldResolver;
      context: unknown;
    } = {
      domainId: existing.domainId,
      input: body.input,
      context,
    };
    if (freeTextResolver !== undefined) {
      resolveInput.freeTextResolver = freeTextResolver;
    }

    try {
      const normalizedInput = await options.normalizeDomainInput(resolveInput);
      const stored = await repository.updateMeta({
        artifactId: planId,
        normalizedInput,
      });
      return c.json(artifactJson(stored));
    } catch (error) {
      asHttpError(error);
    }
  });

  app.post("/plans/:planId/improve", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await options.authorize({ type: "plan.update", planId }, context);

    const planImprover = resolvePlanImprover(options, c.env);
    if (!planImprover) {
      throw new HTTPException(501, {
        message: "planImprover is not configured on this Worker",
      });
    }

    const body = z
      .object({
        request: z.string().min(1).max(4_000),
        constraints: z.unknown().optional(),
      })
      .parse(await c.req.json());

    const repository = repo(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);

    if (existing.currentPlan.steps.length === 0) {
      throw new HTTPException(400, {
        message: "Generate a plan before improving it",
      });
    }

    const improveInput: Parameters<PlanImprover["improve"]>[0] = {
      domainId: existing.domainId,
      basePlan: existing.currentPlan,
      goal: existing.goal,
      request: body.request,
      context,
    };
    if (existing.normalizedInput !== undefined) {
      improveInput.normalizedInput = existing.normalizedInput;
    }
    if (body.constraints !== undefined) {
      improveInput.constraints = body.constraints;
    }

    try {
      const result = await planImprover.improve(improveInput);
      const nextPlan: ExecutionPlan = {
        ...result.plan,
        version: existing.version + 1,
        id: existing.currentPlan.id,
      };

      const stored = await repository.saveVersionStored({
        artifactId: planId,
        plan: nextPlan,
        changeReason: "improve",
        summary: body.request.slice(0, 200),
      });
      return c.json(artifactJson(stored));
    } catch (error) {
      asHttpError(error);
    }
  });

  app.get("/plans/:planId/versions", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await options.authorize({ type: "plan.read", planId }, context);

    try {
      const history = await repo(c.env).getVersionHistory(planId);
      return c.json({ versions: toJsonValue(history) });
    } catch (error) {
      if (error instanceof PlanArtifactNotFoundError) throw error;
      throw error;
    }
  });

  // Surface conflict/not-found as JSON (also handled in app onError if registered).
  void PlanArtifactConflictError;
}
