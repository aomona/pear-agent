import {
  assertPlanMatchesGoal,
  executionGoalSchema,
  planArtifactStatusSchema,
  type ExecutionPlan,
} from "@pear-agent/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { PlanArtifactNotFoundError, type StoredPlanArtifact } from "../../d1/plan-repository.js";
import type { PearApp } from "../../http/app.js";
import { toJsonValue } from "../../serialize.js";
import {
  artifactJson,
  assertReadyPlanHasSteps,
  planRepository,
  planSchema,
  type PlanRouteContext,
} from "./shared.js";

export function registerPlanCrudRoutes(app: PearApp, routes: PlanRouteContext): void {
  app.get("/plans", async (c) => {
    const context = c.get("pearContext");
    await routes.authorize({ type: "plan.list" }, context);
    const domainId = c.req.query("domainId");
    const statusRaw = c.req.query("status");
    const status = statusRaw === undefined ? undefined : planArtifactStatusSchema.parse(statusRaw);
    const list = await planRepository(c.env).listStored({
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
        plan: z.unknown().optional(),
        status: planArtifactStatusSchema.optional(),
        normalizedInput: z.unknown().optional(),
      })
      .parse(await c.req.json());
    await routes.authorize({ type: "plan.create", domainId: body.domainId }, context);
    const goal = executionGoalSchema.parse(body.goal);
    const repository = planRepository(c.env);
    let stored: StoredPlanArtifact;
    if (body.plan !== undefined) {
      const plan = planSchema.parse(body.plan);
      const match = assertPlanMatchesGoal(plan, goal);
      if (!match.ok) {
        throw new HTTPException(400, {
          message: `Plan goal must match the requested goal (${match.reason})`,
        });
      }
      const status = body.status ?? "draft";
      assertReadyPlanHasSteps(status, plan);
      stored = await repository.createStored({
        ...(body.id !== undefined ? { id: body.id } : {}),
        domainId: body.domainId,
        plan,
        status,
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
        ...(body.normalizedInput !== undefined ? { normalizedInput: body.normalizedInput } : {}),
        ownerActorId: context.actorId,
      });
    }
    return c.json(artifactJson(stored), 201);
  });

  app.get("/plans/:planId", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.read", planId }, context);
    const stored = await planRepository(c.env).getStored(planId);
    if (!stored) throw new PlanArtifactNotFoundError(planId);
    return c.json(artifactJson(stored));
  });

  app.patch("/plans/:planId", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.update", planId }, context);
    const body = z
      .object({
        title: z.string().min(1).max(160).nullable().optional(),
        status: planArtifactStatusSchema.optional(),
        normalizedInput: z.unknown().optional(),
        plan: z.unknown().optional(),
        summary: z.string().min(1).max(2_000).optional(),
      })
      .parse(await c.req.json());
    const repository = planRepository(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);
    if (body.plan !== undefined) {
      const nextPlan = planSchema.parse(body.plan) as ExecutionPlan;
      const match = assertPlanMatchesGoal(nextPlan, existing.goal);
      if (!match.ok) {
        throw new HTTPException(400, {
          message: `Replacement plan goal must match artifact goal (${match.reason})`,
        });
      }
      const versioned: ExecutionPlan = {
        ...nextPlan,
        version: existing.version + 1,
        ...(body.title !== undefined && body.title !== null ? { title: body.title } : {}),
      };
      assertReadyPlanHasSteps(body.status ?? existing.status, versioned);
      const stored = await repository.saveVersionStored({
        artifactId: planId,
        plan: versioned,
        changeReason: "user_edit",
        summary: body.summary ?? "User edit",
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.normalizedInput !== undefined ? { normalizedInput: body.normalizedInput } : {}),
      });
      return c.json(artifactJson(stored));
    }
    if (body.status !== undefined) assertReadyPlanHasSteps(body.status, existing.currentPlan);
    const stored = await repository.updateMeta({
      artifactId: planId,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.normalizedInput !== undefined ? { normalizedInput: body.normalizedInput } : {}),
    });
    return c.json(artifactJson(stored));
  });

  app.get("/plans/:planId/versions", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.read", planId }, context);
    const history = await planRepository(c.env).getVersionHistory(planId);
    return c.json({ versions: toJsonValue(history) });
  });
}
