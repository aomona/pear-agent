import {
  diffPlans,
  executionPlanSchema,
  type ExecutionPlan,
  type PlanDiff,
} from "@pear-agent/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { parseJson, serializeJson } from "../serialize.js";
import { createPearDatabase, type PearDatabase } from "./client.js";
import { planEditProposals } from "./schema.js";

const planSchema = executionPlanSchema(z.unknown());

export type PlanEditProposal = {
  id: string;
  planArtifactId: string;
  baseVersion: number;
  request: string;
  candidatePlan: ExecutionPlan;
  diff: PlanDiff;
  status: "pending" | "applied" | "rejected" | "stale";
  createdByActorId: string;
  createdAt: Date;
  appliedAt: Date | null;
};

export class D1PlanEditRepository {
  private readonly db: PearDatabase;

  constructor(d1: D1Database) {
    this.db = createPearDatabase(d1);
  }

  async create(input: {
    planArtifactId: string;
    basePlan: ExecutionPlan;
    candidatePlan: ExecutionPlan;
    request: string;
    createdByActorId: string;
  }): Promise<PlanEditProposal> {
    const now = new Date();
    const candidatePlan = planSchema.parse(input.candidatePlan);
    const proposal: PlanEditProposal = {
      id: crypto.randomUUID(),
      planArtifactId: input.planArtifactId,
      baseVersion: input.basePlan.version,
      request: input.request,
      candidatePlan,
      diff: diffPlans(input.basePlan, candidatePlan),
      status: "pending",
      createdByActorId: input.createdByActorId,
      createdAt: now,
      appliedAt: null,
    };
    await this.db.insert(planEditProposals).values(toRow(proposal));
    return proposal;
  }

  async get(planArtifactId: string, id: string): Promise<PlanEditProposal | null> {
    const rows = await this.db
      .select()
      .from(planEditProposals)
      .where(
        and(eq(planEditProposals.planArtifactId, planArtifactId), eq(planEditProposals.id, id)),
      )
      .limit(1);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async setStatus(
    planArtifactId: string,
    id: string,
    status: PlanEditProposal["status"],
  ): Promise<void> {
    await this.db
      .update(planEditProposals)
      .set({
        status,
        ...(status === "applied" ? { appliedAt: new Date().toISOString() } : {}),
      })
      .where(
        and(
          eq(planEditProposals.planArtifactId, planArtifactId),
          eq(planEditProposals.id, id),
          eq(planEditProposals.status, "pending"),
        ),
      );
  }
}

function toRow(proposal: PlanEditProposal) {
  return {
    id: proposal.id,
    planArtifactId: proposal.planArtifactId,
    baseVersion: proposal.baseVersion,
    request: proposal.request,
    candidatePlanJson: serializeJson(proposal.candidatePlan),
    diffJson: serializeJson(proposal.diff),
    status: proposal.status,
    createdByActorId: proposal.createdByActorId,
    createdAt: proposal.createdAt.toISOString(),
    appliedAt: proposal.appliedAt?.toISOString() ?? null,
  };
}

function fromRow(row: typeof planEditProposals.$inferSelect): PlanEditProposal {
  return {
    id: row.id,
    planArtifactId: row.planArtifactId,
    baseVersion: row.baseVersion,
    request: row.request,
    candidatePlan: planSchema.parse(parseJson(row.candidatePlanJson)),
    diff: parseJson(row.diffJson) as PlanDiff,
    status: z.enum(["pending", "applied", "rejected", "stale"]).parse(row.status),
    createdByActorId: row.createdByActorId,
    createdAt: new Date(row.createdAt),
    appliedAt: row.appliedAt ? new Date(row.appliedAt) : null,
  };
}
