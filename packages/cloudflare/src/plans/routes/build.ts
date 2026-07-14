import { assertPlanMatchesGoal, type ExecutionPlan } from "@pear-agent/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { PlanArtifactNotFoundError } from "../../d1/plan-repository.js";
import type { PearApp } from "../../http/app.js";
import { artifactJson, asHttpError, planRepository, type PlanRouteContext } from "./shared.js";

/** Normalize and generate without exposing a partially updated artifact. */
export function registerPlanBuildRoutes(app: PearApp, routes: PlanRouteContext): void {
  app.post("/plans/:planId/build", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.update", planId }, context);

    const normalizeInput = routes.ports.domain.normalizeInput;
    if (!normalizeInput) {
      throw new HTTPException(501, {
        message: "normalizeDomainInput is not configured on this Worker",
      });
    }

    const body = z.object({ input: z.unknown() }).parse(await c.req.json());
    const repository = planRepository(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);

    const freeTextResolver = routes.ports.freeText.resolve(c.env);
    try {
      const normalizedInput = await normalizeInput({
        domainId: existing.domainId,
        input: body.input,
        ...(freeTextResolver === undefined ? {} : { freeTextResolver }),
        context,
      });
      const generated = await routes.ports.generator.resolve(c.env).generatePlan({
        domainId: existing.domainId,
        goal: existing.goal,
        normalizedInput,
        context,
      });
      const match = assertPlanMatchesGoal(generated, existing.goal);
      if (!match.ok) {
        throw new HTTPException(400, {
          message: `Planner goal must match the artifact goal (${match.reason})`,
        });
      }
      const plan: ExecutionPlan = {
        ...generated,
        version: existing.version + 1,
        id: existing.currentPlan.id,
      };
      const stored = await repository.saveVersionStored({
        artifactId: planId,
        plan,
        changeReason: existing.currentPlan.steps.length === 0 ? "initial" : "improve",
        summary: existing.currentPlan.steps.length === 0 ? "Built plan" : "Rebuilt plan",
        normalizedInput,
      });
      return c.json(artifactJson(stored));
    } catch (error) {
      asHttpError(error);
    }
  });
}
