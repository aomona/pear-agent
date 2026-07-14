import {
  executionPlanSchema,
  planArtifactStatusSchema,
  type ExecutionPlan,
} from "@pear-agent/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AuthorizeFn } from "../../authorize.js";
import { D1PlanRepository, type StoredPlanArtifact } from "../../d1/plan-repository.js";
import { toJsonValue } from "../../serialize.js";
import type { PlanLibraryHostPorts } from "../host-ports.js";

export const planSchema = executionPlanSchema(z.unknown());

export type PlanRouteContext = {
  authorize: AuthorizeFn;
  ports: PlanLibraryHostPorts;
};

export function assertReadyPlanHasSteps(
  status: z.infer<typeof planArtifactStatusSchema>,
  plan: ExecutionPlan,
): void {
  if (status === "ready" && plan.steps.length === 0) {
    throw new HTTPException(400, {
      message: "A ready plan artifact must contain at least one step",
    });
  }
}

export function asHttpError(error: unknown): never {
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

export function planRepository(env: { DB: D1Database }): D1PlanRepository {
  return new D1PlanRepository(env.DB);
}

export function artifactJson(stored: StoredPlanArtifact) {
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
