import {
  assertPlanMatchesGoal,
  validatePlanGraph,
  type ExecutionPlan,
  type PlanImprover,
} from "@pear-agent/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { PlanArtifactNotFoundError } from "../../d1/plan-repository.js";
import { D1PlanEditRepository } from "../../d1/plan-edit-repository.js";
import type { PearApp } from "../../http/app.js";
import { toJsonValue } from "../../serialize.js";
import { artifactJson, asHttpError, planRepository, type PlanRouteContext } from "./shared.js";

export function registerPlanImproveRoutes(app: PearApp, routes: PlanRouteContext): void {
  app.post("/plans/:planId/edit-proposals", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.edit.propose", planId }, context);
    const planImprover = routes.ports.improvement.resolve(c.env);
    if (!planImprover) {
      throw new HTTPException(501, { message: "planImprover is not configured on this Worker" });
    }
    const body = z
      .object({ request: z.string().trim().min(1).max(4_000), constraints: z.unknown().optional() })
      .parse(await c.req.json());
    const repository = planRepository(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);
    if (existing.currentPlan.steps.length === 0) {
      throw new HTTPException(400, { message: "Compile a plan before editing it" });
    }
    const improveInput: Parameters<PlanImprover["improve"]>[0] = {
      domainId: existing.domainId,
      basePlan: existing.currentPlan,
      goal: existing.goal,
      request: body.request,
      context,
      ...(existing.normalizedInput !== undefined
        ? { normalizedInput: existing.normalizedInput }
        : {}),
      ...(body.constraints !== undefined ? { constraints: body.constraints } : {}),
    };
    try {
      const result = await planImprover.improve(improveInput);
      const match = assertPlanMatchesGoal(result.plan, existing.goal);
      if (!match.ok) {
        throw new HTTPException(400, {
          message: `Edited plan goal must match the artifact goal (${match.reason})`,
        });
      }
      const candidatePlan: ExecutionPlan = {
        ...result.plan,
        id: existing.currentPlan.id,
        version: existing.version + 1,
      };
      const graph = validatePlanGraph(candidatePlan.steps);
      if (!graph.valid) {
        throw new HTTPException(400, { message: `Edited plan graph is invalid: ${graph.reason}` });
      }
      try {
        await routes.ports.improvement.validate?.({
          domainId: existing.domainId,
          plan: candidatePlan,
          ...(existing.normalizedInput !== undefined
            ? { normalizedInput: existing.normalizedInput }
            : {}),
        });
      } catch (error) {
        throw new HTTPException(400, {
          message: error instanceof Error ? error.message : "Edited plan violates domain rules",
        });
      }
      const proposal = await new D1PlanEditRepository(c.env.DB).create({
        planArtifactId: planId,
        basePlan: existing.currentPlan,
        candidatePlan,
        request: body.request,
        createdByActorId: context.actorId,
      });
      return c.json({ proposal: toJsonValue(proposal) }, 201);
    } catch (error) {
      asHttpError(error);
    }
  });

  app.post("/plans/:planId/edit-proposals/:proposalId/confirm", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    const proposalId = c.req.param("proposalId");
    await routes.authorize({ type: "plan.edit.confirm", planId, proposalId }, context);
    const editRepository = new D1PlanEditRepository(c.env.DB);
    const proposal = await editRepository.get(planId, proposalId);
    if (!proposal) throw new HTTPException(404, { message: "Plan edit proposal not found" });
    if (proposal.status !== "pending") {
      throw new HTTPException(409, { message: `Plan edit proposal is ${proposal.status}` });
    }
    const repository = planRepository(c.env);
    const existing = await repository.getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);
    if (existing.version !== proposal.baseVersion) {
      await editRepository.setStatus(planId, proposalId, "stale");
      throw new HTTPException(409, { message: "Plan changed after this edit was proposed" });
    }
    const stored = await repository.applyEditProposalStored({
      artifactId: planId,
      proposalId,
      baseVersion: proposal.baseVersion,
      plan: proposal.candidatePlan,
      summary: proposal.request.slice(0, 200),
    });
    return c.json({
      ...artifactJson(stored),
      proposal: toJsonValue({ ...proposal, status: "applied" }),
    });
  });

  app.post("/plans/:planId/improve", async (c) => {
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.update", planId }, c.get("pearContext"));
    throw new HTTPException(410, {
      message: "Direct plan improvement was removed; use /edit-proposals and confirm the diff",
    });
  });
}
