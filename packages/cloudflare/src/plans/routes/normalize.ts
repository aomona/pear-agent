import type { FreeTextFieldResolver } from "@pear-agent/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { PlanArtifactNotFoundError } from "../../d1/plan-repository.js";
import type { PearApp } from "../../http/app.js";
import { artifactJson, asHttpError, planRepository, type PlanRouteContext } from "./shared.js";

export function registerPlanNormalizeRoutes(app: PearApp, routes: PlanRouteContext): void {
  app.post("/plans/:planId/resolve-field", async (c) => {
    const context = c.get("pearContext");
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.update", planId }, context);
    const resolveFreeTextField = routes.ports.domain.resolveFreeTextField;
    if (!resolveFreeTextField) {
      throw new HTTPException(501, {
        message: "resolveDomainFreeTextField is not configured on this Worker",
      });
    }
    const body = z
      .object({ field: z.string().min(1), freeText: z.string().trim().min(1).max(4_000) })
      .parse(await c.req.json());
    const existing = await planRepository(c.env).getStored(planId);
    if (!existing) throw new PlanArtifactNotFoundError(planId);
    const freeTextResolver = routes.ports.freeText.resolve(c.env);
    const input: {
      domainId: string;
      field: string;
      freeText: string;
      freeTextResolver?: FreeTextFieldResolver;
      context: unknown;
    } = { domainId: existing.domainId, field: body.field, freeText: body.freeText, context };
    if (freeTextResolver) input.freeTextResolver = freeTextResolver;
    try {
      const value = await resolveFreeTextField(input);
      return c.json({ field: body.field, value });
    } catch (error) {
      asHttpError(error);
    }
  });

  app.post("/plans/:planId/normalize", async (c) => {
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
    const input: {
      domainId: string;
      input: unknown;
      freeTextResolver?: FreeTextFieldResolver;
      context: unknown;
    } = { domainId: existing.domainId, input: body.input, context };
    if (freeTextResolver) input.freeTextResolver = freeTextResolver;
    try {
      const normalizedInput = await normalizeInput(input);
      const stored = await repository.updateMeta({ artifactId: planId, normalizedInput });
      return c.json(artifactJson(stored));
    } catch (error) {
      asHttpError(error);
    }
  });
}
