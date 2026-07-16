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
import { isUniqueConstraintError } from "./repository.js";
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
  private readonly d1: D1Database;
  private readonly db: PearDatabase;

  constructor(d1: D1Database) {
    this.d1 = d1;
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

    try {
      await this.db.batch([
        this.db.insert(planArtifacts).values(row),
        this.db.insert(planArtifactVersions).values({
          artifactId: id,
          version: plan.version,
          planJson: row.currentPlanJson,
          parentVersion: null,
          changeReason: "initial",
          summary: "Created",
          createdAt: now.toISOString(),
        }),
      ]);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new PlanArtifactConflictError(`Plan artifact already exists: ${id}`);
      }
      throw error;
    }

    return rowToStored(row);
  }

  /** Create a draft artifact with an empty step list (pre-generate). */
  async createDraft(input: {
    id?: string;
    domainId: string;
    goal: ExecutionGoal;
    title?: string;
    normalizedInput?: unknown;
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
      ...(input.normalizedInput !== undefined ? { normalizedInput: input.normalizedInput } : {}),
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
    compileCommit?: { jobId: string; modelCalls: number; totalTokens: number };
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
    const planJson = serializeJson(plan);

    if (input.compileCommit) {
      return this.saveCompileVersionStored({
        input,
        existing,
        plan,
        planJson,
        changeReason,
        status,
        title,
        normalizedInput,
        now,
      });
    }

    // Insert history first, then CAS-update current — one D1 batch so concurrent
    // writers cannot expose current_plan_json without a matching history row.
    // Unique(artifact_id, version) fails and rolls the batch back if two writers race.
    // NOTE: We prefer db.batch() over db.transaction() because miniflare (used by
    // vitest-pool-workers) rejects SQL BEGIN TRANSACTION. The batch is atomic for
    // SQL errors, but if the CAS-UPDATE matches 0 rows (concurrent race), the
    // version-history INSERT already committed. In that case we DELETE the orphaned
    // row manually before throwing the conflict error.
    try {
      const results = await this.db.batch([
        this.db.insert(planArtifactVersions).values({
          artifactId: input.artifactId,
          version: plan.version,
          planJson,
          parentVersion: existing.version,
          changeReason,
          summary: input.summary ?? null,
          createdAt: now.toISOString(),
        }),
        this.db
          .update(planArtifacts)
          .set({
            status,
            title: title ?? null,
            goalJson: serializeJson(plan.goal),
            currentPlanJson: planJson,
            version: plan.version,
            normalizedInputJson:
              normalizedInput === undefined ? null : serializeJson(normalizedInput),
            updatedAt: now.toISOString(),
          })
          .where(
            and(
              eq(planArtifacts.id, input.artifactId),
              eq(planArtifacts.version, existing.version),
            ),
          ),
      ]);
      const updateChanges = (results.at(-1) as { meta?: { changes?: number } } | undefined)?.meta
        ?.changes;
      if (updateChanges === 0) {
        // Clean up orphaned version-history row before throwing
        await this.db
          .delete(planArtifactVersions)
          .where(
            and(
              eq(planArtifactVersions.artifactId, input.artifactId),
              eq(planArtifactVersions.version, plan.version),
            ),
          );
        throw new PlanArtifactConflictError(
          `Plan artifact ${input.artifactId} version race: base ${existing.version} was updated concurrently`,
        );
      }
    } catch (error) {
      if (error instanceof PlanArtifactConflictError) throw error;
      if (isUniqueConstraintError(error)) {
        throw new PlanArtifactConflictError(
          `Plan artifact ${input.artifactId} version ${plan.version} conflict (concurrent update)`,
        );
      }
      throw error;
    }

    const updated = await this.getStored(input.artifactId);
    if (!updated) throw new PlanArtifactNotFoundError(input.artifactId);
    return updated;
  }

  private async saveCompileVersionStored(input: {
    input: {
      artifactId: string;
      summary?: string;
      compileCommit?: { jobId: string; modelCalls: number; totalTokens: number };
    };
    existing: StoredPlanArtifact;
    plan: ExecutionPlan;
    planJson: string;
    changeReason: PlanChangeReason;
    status: PlanArtifactStatus;
    title: string | undefined;
    normalizedInput: unknown;
    now: Date;
  }): Promise<StoredPlanArtifact> {
    const commit = input.input.compileCommit!;
    const token = `compile-commit:${crypto.randomUUID()}`;
    const now = input.now.toISOString();
    const results = await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE compile_jobs
           SET phase = 'review', status = 'completed', model_calls = ?, total_tokens = ?,
               error = ?, updated_at = ?
           WHERE id = ? AND plan_artifact_id = ? AND status = 'running'`,
        )
        .bind(
          commit.modelCalls,
          commit.totalTokens,
          token,
          now,
          commit.jobId,
          input.input.artifactId,
        ),
      this.d1
        .prepare(
          `INSERT INTO plan_artifact_versions
             (artifact_id, version, plan_json, parent_version, change_reason, summary, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM compile_jobs WHERE id = ? AND error = ?)`,
        )
        .bind(
          input.input.artifactId,
          input.plan.version,
          input.planJson,
          input.existing.version,
          input.changeReason,
          input.input.summary ?? null,
          now,
          commit.jobId,
          token,
        ),
      this.d1
        .prepare(
          `UPDATE plan_artifacts
           SET status = ?, title = ?, goal_json = ?, current_plan_json = ?, version = ?,
               normalized_input_json = ?, updated_at = ?
           WHERE id = ? AND version = ?
             AND EXISTS (SELECT 1 FROM compile_jobs WHERE id = ? AND error = ?)`,
        )
        .bind(
          input.status,
          input.title ?? null,
          serializeJson(input.plan.goal),
          input.planJson,
          input.plan.version,
          input.normalizedInput === undefined ? null : serializeJson(input.normalizedInput),
          now,
          input.input.artifactId,
          input.existing.version,
          commit.jobId,
          token,
        ),
      this.d1
        .prepare("UPDATE compile_jobs SET error = NULL WHERE id = ? AND error = ?")
        .bind(commit.jobId, token),
    ]);
    const claimed = results[0]?.meta.changes ?? 0;
    const updatedArtifact = results[2]?.meta.changes ?? 0;
    if (claimed === 0) {
      const job = await this.d1
        .prepare("SELECT status FROM compile_jobs WHERE id = ?")
        .bind(commit.jobId)
        .first<{ status: string }>();
      throw new PlanArtifactConflictError(`Compile job is ${job?.status ?? "missing"}`);
    }
    if (updatedArtifact === 0) {
      await this.d1.batch([
        this.d1
          .prepare("DELETE FROM plan_artifact_versions WHERE artifact_id = ? AND version = ?")
          .bind(input.input.artifactId, input.plan.version),
        this.d1
          .prepare(
            "UPDATE compile_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'completed' AND updated_at = ?",
          )
          .bind("Plan artifact changed during compile commit", now, commit.jobId, now),
      ]);
      throw new PlanArtifactConflictError("Plan artifact changed during compile commit");
    }
    const updated = await this.getStored(input.input.artifactId);
    if (!updated) throw new PlanArtifactNotFoundError(input.input.artifactId);
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
