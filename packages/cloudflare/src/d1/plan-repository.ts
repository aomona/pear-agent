import {
  createPlanVersionRecord,
  executionGoalSchema,
  executionPlanSchema,
  planArtifactSchema,
  planChangeReasonSchema,
  planVersionRecordSchema,
  type ExecutionGoal,
  type ExecutionPlan,
  type PlanArtifact,
  type PlanArtifactStatus,
  type PlanChangeReason,
  type PlanRepository,
  type PlanVersionRecord,
} from "@pear-agent/core";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { parseJson, serializeJson } from "../serialize.js";
import { createPearDatabase, type PearDatabase } from "./client.js";
import { planArtifactVersions, planArtifacts } from "./schema.js";

const planSchema = executionPlanSchema(z.unknown());

/**
 * Adapter-extended plan artifact: Core {@link PlanArtifact} plus Domain input
 * needed to start an Execution Session later.
 */
export type StoredPlanArtifact = PlanArtifact & {
  normalizedInput?: unknown;
  ownerActorId?: string | null;
};

export class PlanArtifactNotFoundError extends Error {
  readonly status = 404;

  constructor(id: string) {
    super(`Plan artifact not found: ${id}`);
    this.name = "PlanArtifactNotFoundError";
  }
}

export class PlanArtifactConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "PlanArtifactConflictError";
  }
}

/**
 * D1 implementation of Core {@link PlanRepository} (CE-11).
 * Extra columns: normalizedInput, ownerActorId (Adapter-only).
 */
export class D1PlanRepository implements PlanRepository {
  private readonly db: PearDatabase;

  constructor(d1: D1Database) {
    this.db = createPearDatabase(d1);
  }

  async create(input: {
    id?: string;
    domainId: string;
    plan: ExecutionPlan;
    status?: PlanArtifactStatus;
    title?: string;
    normalizedInput?: unknown;
    ownerActorId?: string | null;
  }): Promise<PlanArtifact> {
    const stored = await this.createStored(input);
    return toCoreArtifact(stored);
  }

  async createStored(input: {
    id?: string;
    domainId: string;
    plan: ExecutionPlan;
    status?: PlanArtifactStatus;
    title?: string;
    normalizedInput?: unknown;
    ownerActorId?: string | null;
  }): Promise<StoredPlanArtifact> {
    const plan = planSchema.parse(input.plan);
    const id = input.id ?? crypto.randomUUID();
    const now = new Date();
    const status = input.status ?? "draft";
    const title = input.title ?? plan.title;

    const row = {
      id,
      domainId: input.domainId,
      status,
      title: title ?? null,
      goalJson: serializeJson(plan.goal),
      currentPlanJson: serializeJson(plan),
      version: plan.version,
      normalizedInputJson:
        input.normalizedInput === undefined ? null : serializeJson(input.normalizedInput),
      ownerActorId: input.ownerActorId ?? null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await this.db.insert(planArtifacts).values(row);
    await this.db.insert(planArtifactVersions).values({
      artifactId: id,
      version: plan.version,
      planJson: row.currentPlanJson,
      parentVersion: null,
      changeReason: "initial",
      summary: "Created",
      createdAt: now.toISOString(),
    });

    return rowToStored(row);
  }

  /** Create a draft artifact with an empty step list (pre-generate). */
  async createDraft(input: {
    id?: string;
    domainId: string;
    goal: ExecutionGoal;
    title?: string;
    ownerActorId?: string | null;
  }): Promise<StoredPlanArtifact> {
    const goal = executionGoalSchema.parse(input.goal);
    const id = input.id ?? crypto.randomUUID();
    const plan: ExecutionPlan = {
      id: `plan-${id}`,
      version: 1,
      goal,
      steps: [],
      ...(input.title !== undefined ? { title: input.title } : {}),
    };
    return this.createStored({
      id,
      domainId: input.domainId,
      plan,
      status: "draft",
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.ownerActorId !== undefined ? { ownerActorId: input.ownerActorId } : {}),
    });
  }

  async get(id: string): Promise<PlanArtifact | null> {
    const stored = await this.getStored(id);
    return stored ? toCoreArtifact(stored) : null;
  }

  async getStored(id: string): Promise<StoredPlanArtifact | null> {
    const rows = await this.db
      .select()
      .from(planArtifacts)
      .where(eq(planArtifacts.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToStored(row) : null;
  }

  async list(filter?: { domainId?: string; status?: PlanArtifactStatus }): Promise<PlanArtifact[]> {
    const stored = await this.listStored(filter);
    return stored.map(toCoreArtifact);
  }

  async listStored(filter?: {
    domainId?: string;
    status?: PlanArtifactStatus;
  }): Promise<StoredPlanArtifact[]> {
    const conditions = [];
    if (filter?.domainId !== undefined) {
      conditions.push(eq(planArtifacts.domainId, filter.domainId));
    }
    if (filter?.status !== undefined) {
      conditions.push(eq(planArtifacts.status, filter.status));
    }

    const query = this.db.select().from(planArtifacts).orderBy(desc(planArtifacts.updatedAt));
    const rows =
      conditions.length === 0
        ? await query
        : await query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));

    return rows.map(rowToStored);
  }

  async saveVersion(input: {
    artifactId: string;
    plan: ExecutionPlan;
    changeReason: PlanChangeReason;
    summary?: string;
    status?: PlanArtifactStatus;
    normalizedInput?: unknown;
  }): Promise<PlanArtifact> {
    const stored = await this.saveVersionStored(input);
    return toCoreArtifact(stored);
  }

  async saveVersionStored(input: {
    artifactId: string;
    plan: ExecutionPlan;
    changeReason: PlanChangeReason;
    summary?: string;
    status?: PlanArtifactStatus;
    normalizedInput?: unknown;
  }): Promise<StoredPlanArtifact> {
    const existing = await this.getStored(input.artifactId);
    if (!existing) throw new PlanArtifactNotFoundError(input.artifactId);

    const plan = planSchema.parse(input.plan);
    const changeReason = planChangeReasonSchema.parse(input.changeReason);
    if (plan.version <= existing.version) {
      throw new PlanArtifactConflictError(
        `Plan version ${plan.version} must be greater than current ${existing.version}`,
      );
    }

    const now = new Date();
    const status = input.status ?? existing.status;
    const title = plan.title ?? existing.title;
    const normalizedInput =
      input.normalizedInput !== undefined ? input.normalizedInput : existing.normalizedInput;

    await this.db
      .update(planArtifacts)
      .set({
        status,
        title: title ?? null,
        goalJson: serializeJson(plan.goal),
        currentPlanJson: serializeJson(plan),
        version: plan.version,
        normalizedInputJson: normalizedInput === undefined ? null : serializeJson(normalizedInput),
        updatedAt: now.toISOString(),
      })
      .where(eq(planArtifacts.id, input.artifactId));

    await this.db.insert(planArtifactVersions).values({
      artifactId: input.artifactId,
      version: plan.version,
      planJson: serializeJson(plan),
      parentVersion: existing.version,
      changeReason,
      summary: input.summary ?? null,
      createdAt: now.toISOString(),
    });

    const updated = await this.getStored(input.artifactId);
    if (!updated) throw new PlanArtifactNotFoundError(input.artifactId);
    return updated;
  }

  async updateMeta(input: {
    artifactId: string;
    title?: string | null;
    status?: PlanArtifactStatus;
    normalizedInput?: unknown;
  }): Promise<StoredPlanArtifact> {
    const existing = await this.getStored(input.artifactId);
    if (!existing) throw new PlanArtifactNotFoundError(input.artifactId);

    const now = new Date().toISOString();
    await this.db
      .update(planArtifacts)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.normalizedInput !== undefined
          ? { normalizedInputJson: serializeJson(input.normalizedInput) }
          : {}),
        updatedAt: now,
      })
      .where(eq(planArtifacts.id, input.artifactId));

    const updated = await this.getStored(input.artifactId);
    if (!updated) throw new PlanArtifactNotFoundError(input.artifactId);
    return updated;
  }

  /**
   * Replace the current plan snapshot without bumping version.
   * Used for first generate on an empty draft (v1 shell → real plan).
   */
  async replaceCurrentPlan(input: {
    artifactId: string;
    plan: ExecutionPlan;
    changeReason?: PlanChangeReason;
    summary?: string;
    normalizedInput?: unknown;
    status?: PlanArtifactStatus;
  }): Promise<StoredPlanArtifact> {
    const existing = await this.getStored(input.artifactId);
    if (!existing) throw new PlanArtifactNotFoundError(input.artifactId);

    const plan = planSchema.parse(input.plan);
    if (plan.version !== existing.version) {
      throw new PlanArtifactConflictError(
        `replaceCurrentPlan requires plan.version === ${existing.version}`,
      );
    }

    const now = new Date().toISOString();
    const status = input.status ?? existing.status;
    const normalizedInput =
      input.normalizedInput !== undefined ? input.normalizedInput : existing.normalizedInput;

    await this.db
      .update(planArtifacts)
      .set({
        status,
        title: plan.title ?? existing.title ?? null,
        goalJson: serializeJson(plan.goal),
        currentPlanJson: serializeJson(plan),
        version: plan.version,
        normalizedInputJson: normalizedInput === undefined ? null : serializeJson(normalizedInput),
        updatedAt: now,
      })
      .where(eq(planArtifacts.id, input.artifactId));

    await this.db
      .update(planArtifactVersions)
      .set({
        planJson: serializeJson(plan),
        changeReason: input.changeReason ?? "initial",
        summary: input.summary ?? null,
      })
      .where(
        and(
          eq(planArtifactVersions.artifactId, input.artifactId),
          eq(planArtifactVersions.version, plan.version),
        ),
      );

    const updated = await this.getStored(input.artifactId);
    if (!updated) throw new PlanArtifactNotFoundError(input.artifactId);
    return updated;
  }

  async getVersionHistory(artifactId: string): Promise<PlanVersionRecord[]> {
    const existing = await this.getStored(artifactId);
    if (!existing) throw new PlanArtifactNotFoundError(artifactId);

    const rows = await this.db
      .select()
      .from(planArtifactVersions)
      .where(eq(planArtifactVersions.artifactId, artifactId))
      .orderBy(desc(planArtifactVersions.version));

    return rows.map((row) =>
      planVersionRecordSchema.parse(
        createPlanVersionRecord({
          planId: existing.currentPlan.id,
          plan: planSchema.parse(parseJson(row.planJson)),
          changeReason: planChangeReasonSchema.parse(row.changeReason),
          parentVersion: row.parentVersion,
          ...(row.summary !== null && row.summary !== undefined ? { summary: row.summary } : {}),
          createdAt: new Date(row.createdAt),
        }),
      ),
    );
  }
}

function rowToStored(row: {
  id: string;
  domainId: string;
  status: string;
  title: string | null;
  goalJson: string;
  currentPlanJson: string;
  version: number;
  normalizedInputJson: string | null;
  ownerActorId: string | null;
  createdAt: string;
  updatedAt: string;
}): StoredPlanArtifact {
  const plan = planSchema.parse(parseJson(row.currentPlanJson));
  const goal = executionGoalSchema.parse(parseJson(row.goalJson));
  const artifact = planArtifactSchema.parse({
    id: row.id,
    domainId: row.domainId,
    status: row.status,
    currentPlan: plan,
    version: row.version,
    goal,
    ...(row.title ? { title: row.title } : {}),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  });

  return {
    ...artifact,
    ownerActorId: row.ownerActorId,
    ...(row.normalizedInputJson ? { normalizedInput: parseJson(row.normalizedInputJson) } : {}),
  };
}

function toCoreArtifact(stored: StoredPlanArtifact): PlanArtifact {
  const { normalizedInput: _n, ownerActorId: _o, ...core } = stored;
  return core;
}
