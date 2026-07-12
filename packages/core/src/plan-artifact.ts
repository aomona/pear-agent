import { z } from "zod";

import { dateSchema } from "./date.js";
import { executionGoalSchema } from "./goal.js";
import { executionPlanSchema } from "./plan.js";

/** CE-12 */
export const planChangeReasonSchema = z.enum([
  "initial",
  "improve",
  "runtime_replan",
  "user_edit",
  "rollback",
]);
export type PlanChangeReason = z.infer<typeof planChangeReasonSchema>;

export const planVersionRecordSchema = z.object({
  planId: z.string().min(1),
  version: z.number().int().positive(),
  plan: executionPlanSchema(z.unknown()),
  parentVersion: z.number().int().positive().nullable().optional(),
  changeReason: planChangeReasonSchema,
  summary: z.string().min(1).max(2_000).optional(),
  createdAt: dateSchema,
});

export type PlanVersionRecord = z.infer<typeof planVersionRecordSchema>;

/** CE-11 */
export const planArtifactStatusSchema = z.enum(["draft", "ready", "archived"]);
export type PlanArtifactStatus = z.infer<typeof planArtifactStatusSchema>;

export const planArtifactSchema = z.object({
  id: z.string().min(1),
  domainId: z.string().min(1),
  status: planArtifactStatusSchema,
  currentPlan: executionPlanSchema(z.unknown()),
  version: z.number().int().positive(),
  goal: executionGoalSchema,
  title: z.string().min(1).max(160).optional(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

export type PlanArtifact = z.infer<typeof planArtifactSchema>;

/**
 * CE-11 Port: durable plan library (Adapter implements with D1 etc.).
 */
export type PlanRepository = {
  create(input: {
    id?: string;
    domainId: string;
    plan: z.infer<ReturnType<typeof executionPlanSchema>>;
    status?: PlanArtifactStatus;
  }): Promise<PlanArtifact>;
  get(id: string): Promise<PlanArtifact | null>;
  list(filter?: { domainId?: string; status?: PlanArtifactStatus }): Promise<PlanArtifact[]>;
  saveVersion(input: {
    artifactId: string;
    plan: PlanArtifact["currentPlan"];
    changeReason: PlanChangeReason;
    summary?: string;
    status?: PlanArtifactStatus;
  }): Promise<PlanArtifact>;
  getVersionHistory(artifactId: string): Promise<PlanVersionRecord[]>;
};

export function createPlanVersionRecord(input: {
  planId: string;
  plan: PlanArtifact["currentPlan"];
  changeReason: PlanChangeReason;
  parentVersion?: number | null;
  summary?: string;
  createdAt?: Date;
}): PlanVersionRecord {
  const record: PlanVersionRecord = {
    planId: input.planId,
    version: input.plan.version,
    plan: input.plan,
    changeReason: input.changeReason,
    createdAt: input.createdAt ?? new Date(),
  };
  if (input.parentVersion !== undefined) record.parentVersion = input.parentVersion;
  if (input.summary !== undefined) record.summary = input.summary;
  return record;
}
