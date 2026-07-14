import { assertPlanMatchesGoal, executionGoalSchema, type ExecutionPlan } from "@pear-agent/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { PlanArtifactNotFoundError } from "../../d1/plan-repository.js";
import type { PearApp } from "../../http/app.js";
import { artifactJson, planRepository, type PlanRouteContext } from "./shared.js";

export function registerPlanGenerateRoutes(app: PearApp, routes: PlanRouteContext): void {
  app.post("/plans/:planId/generate", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.update", planId }, context);
    const body = z
      .object({ normalizedInput: z.unknown().optional(), goal: z.unknown().optional() })
      .parse((await c.req.json().catch(() => ({}))) as unknown);
    const repository = planRepository(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);
    const normalizedInput = body.normalizedInput ?? existing.normalizedInput;
    if (normalizedInput === undefined) {
      throw new HTTPException(400, {
        message: "normalizedInput is required (store on artifact or pass in body)",
      });
    }
    if (body.goal !== undefined) {
      const requestedGoal = executionGoalSchema.parse(body.goal);
      const goalMatch = assertPlanMatchesGoal({ goal: existing.goal }, requestedGoal);
      if (!goalMatch.ok) {
        throw new HTTPException(400, {
          message: `Generation goal must match artifact goal (${goalMatch.reason})`,
        });
      }
    }
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
      summary: existing.currentPlan.steps.length === 0 ? "Generated plan" : "Regenerated plan",
      normalizedInput,
    });
    return c.json(artifactJson(stored));
  });
}
