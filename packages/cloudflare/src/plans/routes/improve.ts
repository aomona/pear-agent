import { assertPlanMatchesGoal, type ExecutionPlan, type PlanImprover } from "@pear-agent/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { PlanArtifactNotFoundError } from "../../d1/plan-repository.js";
import type { PearApp } from "../../http/app.js";
import { artifactJson, asHttpError, planRepository, type PlanRouteContext } from "./shared.js";

export function registerPlanImproveRoutes(app: PearApp, routes: PlanRouteContext): void {
  app.post("/plans/:planId/improve", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.update", planId }, context);
    const planImprover = routes.ports.improvement.resolve(c.env);
    if (!planImprover) {
      throw new HTTPException(501, { message: "planImprover is not configured on this Worker" });
    }
    const body = z
      .object({ request: z.string().min(1).max(4_000), constraints: z.unknown().optional() })
      .parse(await c.req.json());
    const repository = planRepository(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);
    if (existing.currentPlan.steps.length === 0) {
      throw new HTTPException(400, { message: "Generate a plan before improving it" });
    }
    const improveInput: Parameters<PlanImprover["improve"]>[0] = {
      domainId: existing.domainId,
      basePlan: existing.currentPlan,
      goal: existing.goal,
      request: body.request,
      context,
    };
    if (existing.normalizedInput !== undefined)
      improveInput.normalizedInput = existing.normalizedInput;
    if (body.constraints !== undefined) improveInput.constraints = body.constraints;
    try {
      const result = await planImprover.improve(improveInput);
      const match = assertPlanMatchesGoal(result.plan, existing.goal);
      if (!match.ok) {
        throw new HTTPException(400, {
          message: `Improved plan goal must match the artifact goal (${match.reason})`,
        });
      }
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
}
