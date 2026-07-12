import { z } from "zod";

import { dateSchema } from "./date.js";
import { executionGoalSchema, type ExecutionGoal } from "./goal.js";
import { executionPlanSchema, type ExecutionPlan } from "./plan.js";

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

export type PlanVersionRecord = {
  planId: string;
  version: number;
  plan: ExecutionPlan;
  parentVersion?: number | null;
  changeReason: PlanChangeReason;
  summary?: string;
  createdAt: Date;
};

/** CE-11 */
export const planArtifactStatusSchema = z.enum(["draft", "ready", "archived"]);
export type PlanArtifactStatus = z.infer<typeof planArtifactStatusSchema>;

export type PlanArtifact = {
  id: string;
  domainId: string;
  status: PlanArtifactStatus;
  currentPlan: ExecutionPlan;
  version: number;
  goal: ExecutionGoal;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
};

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

/**
 * CE-11 Port: durable plan library (Adapter implements with D1 etc.).
 */
export type PlanRepository = {
  create(input: {
    id?: string;
    domainId: string;
    plan: ExecutionPlan;
    status?: PlanArtifactStatus;
  }): Promise<PlanArtifact>;
  get(id: string): Promise<PlanArtifact | null>;
  list(filter?: { domainId?: string; status?: PlanArtifactStatus }): Promise<PlanArtifact[]>;
  saveVersion(input: {
    artifactId: string;
    plan: ExecutionPlan;
    changeReason: PlanChangeReason;
    summary?: string;
    status?: PlanArtifactStatus;
  }): Promise<PlanArtifact>;
  getVersionHistory(artifactId: string): Promise<PlanVersionRecord[]>;
};

export function createPlanVersionRecord(input: {
  planId: string;
  plan: ExecutionPlan;
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
