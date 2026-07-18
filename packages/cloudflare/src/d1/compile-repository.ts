import {
  clarificationRequestSchema,
  compileJobSchema,
  generationMetadataSchema,
  interpretationAssumptionSchema,
  sourceArtifactSchema,
  type ClarificationQuestion,
  type ClarificationRequest,
  type CompileJob,
  type CompileJobStatus,
  type CompilePhase,
  type GenerationMetadata,
  type InterpretationAssumption,
  type SourceArtifact,
  type SourceKind,
} from "@pear-agent/core";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { parseJson, serializeJson } from "../serialize.js";
import { createPearDatabase, type PearDatabase } from "./client.js";
import { isUniqueConstraintError } from "./repository.js";
import {
  clarificationRequests,
  compileJobs,
  generationRecords,
  interpretationArtifacts,
  planSources,
} from "./schema.js";

export type StoredInterpretation = {
  id: string;
  planArtifactId: string;
  compileJobId: string;
  revision: number;
  normalizedInput: unknown;
  assumptions: InterpretationAssumption[];
  generation: GenerationMetadata;
  createdAt: Date;
};

export type PlanArtifactInspector = {
  sources: SourceArtifact[];
  jobs: CompileJob[];
  interpretations: StoredInterpretation[];
  clarifications: ClarificationRequest[];
  generations: GenerationMetadata[];
};

export class CompileJobNotFoundError extends Error {
  readonly status = 404;

  constructor(id: string) {
    super(`Compile job not found: ${id}`);
    this.name = "CompileJobNotFoundError";
  }
}

export class ClarificationNotFoundError extends Error {
  readonly status = 404;

  constructor(id: string) {
    super(`Clarification request not found: ${id}`);
    this.name = "ClarificationNotFoundError";
  }
}

export class CompileJobConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "CompileJobConflictError";
  }
}

export class D1CompileRepository {
  private readonly d1: D1Database;
  private readonly db: PearDatabase;

  constructor(d1: D1Database) {
    this.d1 = d1;
    this.db = createPearDatabase(d1);
  }

  async createSource(input: {
    id?: string;
    planArtifactId: string;
    kind: SourceKind;
    label: string;
    mediaType: string;
    byteSize: number;
    checksumSha256: string;
    createdByActorId: string;
    sourceUrl?: string | null;
    rawObjectKey?: string | null;
    extractedObjectKey?: string | null;
  }): Promise<SourceArtifact> {
    const now = new Date();
    const source = sourceArtifactSchema.parse({
      id: input.id ?? crypto.randomUUID(),
      ...input,
      status: "ready",
      sourceUrl: input.sourceUrl ?? null,
      rawObjectKey: input.rawObjectKey ?? null,
      extractedObjectKey: input.extractedObjectKey ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await this.db.insert(planSources).values(sourceToRow(source));
    return source;
  }

  async createSourceIfIdle(
    input: Parameters<D1CompileRepository["createSource"]>[0],
    maximumSources: number,
  ): Promise<SourceArtifact> {
    const now = new Date();
    const source = sourceArtifactSchema.parse({
      id: input.id ?? crypto.randomUUID(),
      ...input,
      status: "ready",
      sourceUrl: input.sourceUrl ?? null,
      rawObjectKey: input.rawObjectKey ?? null,
      extractedObjectKey: input.extractedObjectKey ?? null,
      createdAt: now,
      updatedAt: now,
    });
    const row = sourceToRow(source);
    const result = await this.d1
      .prepare(
        `INSERT INTO plan_sources (
          id, plan_artifact_id, kind, status, label, media_type, byte_size,
          checksum_sha256, source_url, raw_object_key, extracted_object_key,
          created_by_actor_id, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM compile_jobs
          WHERE plan_artifact_id = ? AND status IN ('queued', 'running', 'waiting')
        ) AND (
          SELECT COUNT(*) FROM plan_sources
          WHERE plan_artifact_id = ? AND status != 'deleted'
        ) < ?`,
      )
      .bind(
        row.id,
        row.planArtifactId,
        row.kind,
        row.status,
        row.label,
        row.mediaType,
        row.byteSize,
        row.checksumSha256,
        row.sourceUrl,
        row.rawObjectKey,
        row.extractedObjectKey,
        row.createdByActorId,
        row.createdAt,
        row.updatedAt,
        row.planArtifactId,
        row.planArtifactId,
        maximumSources,
      )
      .run();
    if (result.meta.changes === 0) {
      if (await this.getActiveJob(input.planArtifactId)) {
        throw new CompileJobConflictError("Sources cannot change during an active compile");
      }
      throw new CompileJobConflictError(`A plan may have at most ${maximumSources} sources`);
    }
    return source;
  }

  async listSources(planArtifactId: string): Promise<SourceArtifact[]> {
    const rows = await this.db
      .select()
      .from(planSources)
      .where(eq(planSources.planArtifactId, planArtifactId))
      .orderBy(planSources.createdAt);
    return rows.map(sourceFromRow);
  }

  async markSourceDeleted(
    planArtifactId: string,
    sourceId: string,
  ): Promise<SourceArtifact | null> {
    const rows = await this.db
      .select()
      .from(planSources)
      .where(and(eq(planSources.planArtifactId, planArtifactId), eq(planSources.id, sourceId)))
      .limit(1);
    if (!rows[0]) return null;
    const updatedAt = new Date();
    await this.db
      .update(planSources)
      .set({ status: "deleted", updatedAt: updatedAt.toISOString() })
      .where(eq(planSources.id, sourceId));
    return sourceArtifactSchema.parse({ ...rows[0], status: "deleted", updatedAt });
  }

  async markSourceDeletingIfIdle(
    planArtifactId: string,
    sourceId: string,
  ): Promise<SourceArtifact | null> {
    const rows = await this.db
      .select()
      .from(planSources)
      .where(and(eq(planSources.planArtifactId, planArtifactId), eq(planSources.id, sourceId)))
      .limit(1);
    if (!rows[0] || rows[0].status === "deleted") return null;
    const updatedAt = new Date();
    const result = await this.d1
      .prepare(
        `UPDATE plan_sources
         SET status = 'deleting', updated_at = ?
         WHERE id = ? AND plan_artifact_id = ? AND status != 'deleted'
           AND NOT EXISTS (
             SELECT 1 FROM compile_jobs
             WHERE plan_artifact_id = ? AND status IN ('queued', 'running', 'waiting')
           )`,
      )
      .bind(updatedAt.toISOString(), sourceId, planArtifactId, planArtifactId)
      .run();
    if (result.meta.changes === 0) {
      if (await this.getActiveJob(planArtifactId)) {
        throw new CompileJobConflictError("Sources cannot change during an active compile");
      }
      return null;
    }
    return sourceArtifactSchema.parse({ ...rows[0], status: "deleting", updatedAt });
  }

  async finalizeSourceDeleted(planArtifactId: string, sourceId: string): Promise<void> {
    await this.db
      .update(planSources)
      .set({ status: "deleted", updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(planSources.planArtifactId, planArtifactId),
          eq(planSources.id, sourceId),
          eq(planSources.status, "deleting"),
        ),
      );
  }

  async isSourceReferenced(planArtifactId: string, sourceId: string): Promise<boolean> {
    const [interpretationRows, clarificationRows] = await Promise.all([
      this.db
        .select({ assumptionsJson: interpretationArtifacts.assumptionsJson })
        .from(interpretationArtifacts)
        .where(eq(interpretationArtifacts.planArtifactId, planArtifactId)),
      this.db
        .select({ questionsJson: clarificationRequests.questionsJson })
        .from(clarificationRequests)
        .where(eq(clarificationRequests.planArtifactId, planArtifactId)),
    ]);
    const referenced = (value: unknown): boolean =>
      Array.isArray(value) &&
      value.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "sourceRefs" in item &&
          Array.isArray(item.sourceRefs) &&
          item.sourceRefs.some(
            (reference: unknown) =>
              typeof reference === "object" &&
              reference !== null &&
              "sourceId" in reference &&
              reference.sourceId === sourceId,
          ),
      );
    return (
      interpretationRows.some(({ assumptionsJson }) => referenced(parseJson(assumptionsJson))) ||
      clarificationRows.some(({ questionsJson }) => referenced(parseJson(questionsJson)))
    );
  }

  async createJob(planArtifactId: string, attempt = 1): Promise<CompileJob> {
    await this.expireClarifications(planArtifactId);
    const active = await this.db
      .select({ id: compileJobs.id })
      .from(compileJobs)
      .where(
        and(
          eq(compileJobs.planArtifactId, planArtifactId),
          sql`${compileJobs.status} IN ('queued', 'running', 'waiting')`,
        ),
      )
      .limit(1);
    if (active.length > 0) {
      throw new CompileJobConflictError(`Plan artifact already has an active compile job`);
    }
    const now = new Date();
    const job = compileJobSchema.parse({
      id: crypto.randomUUID(),
      planArtifactId,
      workflowInstanceId: null,
      phase: "queued",
      status: "queued",
      attempt,
      modelCalls: 0,
      totalTokens: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.db.insert(compileJobs).values(jobToRow(job));
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new CompileJobConflictError(`Plan artifact already has an active compile job`);
      }
      throw error;
    }
    return job;
  }

  async getJob(id: string): Promise<CompileJob | null> {
    const rows = await this.db.select().from(compileJobs).where(eq(compileJobs.id, id)).limit(1);
    return rows[0] ? jobFromRow(rows[0]) : null;
  }

  async expireClarifications(planArtifactId: string): Promise<void> {
    const expired = await this.db
      .select({ id: clarificationRequests.id, compileJobId: clarificationRequests.compileJobId })
      .from(clarificationRequests)
      .where(
        and(
          eq(clarificationRequests.planArtifactId, planArtifactId),
          eq(clarificationRequests.status, "pending"),
          lt(clarificationRequests.expiresAt, new Date().toISOString()),
        ),
      );
    if (expired.length === 0) return;
    for (const { id, compileJobId } of expired) {
      await this.db.batch([
        this.db
          .update(clarificationRequests)
          .set({ status: "expired" })
          .where(
            and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "pending")),
          ),
        this.db
          .update(compileJobs)
          .set({ status: "expired", updatedAt: new Date().toISOString() })
          .where(and(eq(compileJobs.id, compileJobId), eq(compileJobs.status, "waiting"))),
      ]);
    }
  }

  async getActiveJob(planArtifactId: string): Promise<CompileJob | null> {
    const rows = await this.db
      .select()
      .from(compileJobs)
      .where(
        and(
          eq(compileJobs.planArtifactId, planArtifactId),
          sql`${compileJobs.status} IN ('queued', 'running', 'waiting')`,
        ),
      )
      .limit(1);
    return rows[0] ? jobFromRow(rows[0]) : null;
  }

  async updateJob(
    id: string,
    update: {
      phase?: CompilePhase;
      status?: CompileJobStatus;
      workflowInstanceId?: string | null;
      modelCalls?: number;
      totalTokens?: number;
      error?: string | null;
    },
  ): Promise<CompileJob> {
    const existing = await this.getJob(id);
    if (!existing) throw new CompileJobNotFoundError(id);
    await this.db
      .update(compileJobs)
      .set({ ...update, updatedAt: new Date().toISOString() })
      .where(eq(compileJobs.id, id));
    const updated = await this.getJob(id);
    if (!updated) throw new CompileJobNotFoundError(id);
    return updated;
  }

  async transitionJob(
    id: string,
    fromStatuses: readonly CompileJobStatus[],
    update: {
      phase?: CompilePhase;
      status?: CompileJobStatus;
      modelCalls?: number;
      totalTokens?: number;
      error?: string | null;
    },
  ): Promise<CompileJob> {
    const rows = await this.db
      .update(compileJobs)
      .set({ ...update, updatedAt: new Date().toISOString() })
      .where(and(eq(compileJobs.id, id), inArray(compileJobs.status, [...fromStatuses])))
      .returning();
    if (!rows[0]) {
      const current = await this.getJob(id);
      if (!current) throw new CompileJobNotFoundError(id);
      throw new CompileJobConflictError(`Compile job is ${current.status}`);
    }
    return jobFromRow(rows[0]);
  }

  async saveInterpretation(input: {
    planArtifactId: string;
    compileJobId: string;
    normalizedInput: unknown;
    assumptions: InterpretationAssumption[];
    generation: GenerationMetadata;
  }): Promise<StoredInterpretation> {
    const existingRows = await this.db
      .select()
      .from(interpretationArtifacts)
      .where(eq(interpretationArtifacts.compileJobId, input.compileJobId))
      .limit(1);
    if (existingRows[0]) {
      // Workflow retries re-run AI for the same jobId; overwrite so plan and interpretation stay aligned.
      const row = existingRows[0];
      const assumptions = input.assumptions.map((item) =>
        interpretationAssumptionSchema.parse(item),
      );
      const generation = generationMetadataSchema.parse(input.generation);
      await this.db
        .update(interpretationArtifacts)
        .set({
          normalizedInputJson: serializeJson(input.normalizedInput),
          assumptionsJson: serializeJson(assumptions),
          generationJson: serializeJson(generation),
        })
        .where(eq(interpretationArtifacts.id, row.id));
      return {
        id: row.id,
        planArtifactId: row.planArtifactId,
        compileJobId: row.compileJobId,
        revision: row.revision,
        normalizedInput: input.normalizedInput,
        assumptions,
        generation,
        createdAt: new Date(row.createdAt),
      };
    }
    const revisions = await this.db
      .select({ revision: interpretationArtifacts.revision })
      .from(interpretationArtifacts)
      .where(eq(interpretationArtifacts.planArtifactId, input.planArtifactId))
      .orderBy(desc(interpretationArtifacts.revision))
      .limit(1);
    const createdAt = new Date();
    const stored: StoredInterpretation = {
      id: crypto.randomUUID(),
      ...input,
      assumptions: input.assumptions.map((item) => interpretationAssumptionSchema.parse(item)),
      generation: generationMetadataSchema.parse(input.generation),
      revision: (revisions[0]?.revision ?? 0) + 1,
      createdAt,
    };
    await this.db.batch([
      this.db.insert(interpretationArtifacts).values({
        id: stored.id,
        planArtifactId: stored.planArtifactId,
        compileJobId: stored.compileJobId,
        revision: stored.revision,
        normalizedInputJson: serializeJson(stored.normalizedInput),
        assumptionsJson: serializeJson(stored.assumptions),
        generationJson: serializeJson(stored.generation),
        createdAt: createdAt.toISOString(),
      }),
      this.db.insert(generationRecords).values(generationToRow(input, input.generation)),
    ]);
    return stored;
  }

  async recordGeneration(input: {
    planArtifactId: string;
    compileJobId: string;
    generation: GenerationMetadata;
  }): Promise<void> {
    const existing = await this.db
      .select({ id: generationRecords.id })
      .from(generationRecords)
      .where(
        and(
          eq(generationRecords.compileJobId, input.compileJobId),
          eq(generationRecords.stage, input.generation.stage),
        ),
      )
      .limit(1);
    if (existing[0]) return;
    await this.db.insert(generationRecords).values(generationToRow(input, input.generation));
  }

  async createClarification(input: {
    planArtifactId: string;
    compileJobId: string;
    questions: ClarificationQuestion[];
    expiresAt: Date;
  }): Promise<ClarificationRequest> {
    const existing = await this.db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.compileJobId, input.compileJobId))
      .limit(1);
    if (existing[0]) return clarificationFromRow(existing[0]);
    const now = new Date();
    const request = clarificationRequestSchema.parse({
      id: crypto.randomUUID(),
      ...input,
      status: "pending",
      answers: {},
      createdAt: now,
      answeredAt: null,
    });
    await this.db.insert(clarificationRequests).values(clarificationToRow(request));
    return request;
  }

  async getClarificationForJob(compileJobId: string): Promise<ClarificationRequest | null> {
    const rows = await this.db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.compileJobId, compileJobId))
      .limit(1);
    return rows[0] ? clarificationFromRow(rows[0]) : null;
  }

  async answerClarification(
    planArtifactId: string,
    id: string,
    answers: Readonly<Record<string, string>>,
  ): Promise<ClarificationRequest> {
    const rows = await this.db
      .select()
      .from(clarificationRequests)
      .where(
        and(
          eq(clarificationRequests.planArtifactId, planArtifactId),
          eq(clarificationRequests.id, id),
        ),
      )
      .limit(1);
    const current = rows[0] ? clarificationFromRow(rows[0]) : null;
    if (!current) throw new ClarificationNotFoundError(id);
    if (current.status !== "pending") {
      throw new CompileJobConflictError(`Clarification request is ${current.status}`);
    }
    if (current.expiresAt <= new Date()) {
      const expiredAt = new Date().toISOString();
      await this.db.batch([
        this.db
          .update(clarificationRequests)
          .set({ status: "expired" })
          .where(
            and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "pending")),
          ),
        this.db
          .update(compileJobs)
          .set({
            status: "expired",
            error: "Clarification request expired",
            updatedAt: expiredAt,
          })
          .where(and(eq(compileJobs.id, current.compileJobId), eq(compileJobs.status, "waiting"))),
      ]);
      throw new CompileJobConflictError("Clarification request has expired");
    }
    const expectedQuestionIds = current.questions.map(({ id: questionId }) => questionId).sort();
    const answerIds = Object.keys(answers).sort();
    if (
      expectedQuestionIds.length !== answerIds.length ||
      expectedQuestionIds.some((questionId, index) => questionId !== answerIds[index]) ||
      Object.values(answers).some((answer) => answer.trim().length === 0)
    ) {
      throw new CompileJobConflictError(
        "Answers must contain exactly one non-empty value for every clarification question",
      );
    }
    const answeredAt = new Date();
    // Re-queue the same job so clarification is a resume, not cancel+new-job.
    const [updated] = await this.db.batch([
      this.db
        .update(clarificationRequests)
        .set({
          status: "answered",
          answersJson: serializeJson(answers),
          answeredAt: answeredAt.toISOString(),
        })
        .where(
          and(
            eq(clarificationRequests.planArtifactId, planArtifactId),
            eq(clarificationRequests.id, id),
            eq(clarificationRequests.status, "pending"),
          ),
        )
        .returning(),
      this.db
        .update(compileJobs)
        .set({
          status: "queued",
          phase: "queued",
          error: null,
          updatedAt: answeredAt.toISOString(),
        })
        .where(and(eq(compileJobs.id, current.compileJobId), eq(compileJobs.status, "waiting"))),
    ]);
    if (!updated[0]) {
      throw new CompileJobConflictError("Clarification request is no longer pending");
    }
    return clarificationFromRow(updated[0]);
  }

  async inspect(planArtifactId: string): Promise<PlanArtifactInspector> {
    const [sources, jobs, interpretationRows, clarificationRows, generationRows] =
      await Promise.all([
        this.listSources(planArtifactId),
        this.db
          .select()
          .from(compileJobs)
          .where(eq(compileJobs.planArtifactId, planArtifactId))
          .orderBy(desc(compileJobs.createdAt)),
        this.db
          .select()
          .from(interpretationArtifacts)
          .where(eq(interpretationArtifacts.planArtifactId, planArtifactId))
          .orderBy(desc(interpretationArtifacts.revision)),
        this.db
          .select()
          .from(clarificationRequests)
          .where(eq(clarificationRequests.planArtifactId, planArtifactId))
          .orderBy(desc(clarificationRequests.createdAt)),
        this.db
          .select()
          .from(generationRecords)
          .where(eq(generationRecords.planArtifactId, planArtifactId))
          .orderBy(desc(generationRecords.createdAt)),
      ]);
    return {
      sources,
      jobs: jobs.map(jobFromRow),
      interpretations: interpretationRows.map((row) => ({
        id: row.id,
        planArtifactId: row.planArtifactId,
        compileJobId: row.compileJobId,
        revision: row.revision,
        normalizedInput: parseJson(row.normalizedInputJson),
        assumptions: parseJson(row.assumptionsJson) as InterpretationAssumption[],
        generation: generationMetadataSchema.parse(parseJson(row.generationJson)),
        createdAt: new Date(row.createdAt),
      })),
      clarifications: clarificationRows.map(clarificationFromRow),
      generations: generationRows.map((row) =>
        generationMetadataSchema.parse(parseJson(row.metadataJson)),
      ),
    };
  }
}

function sourceToRow(source: SourceArtifact) {
  return {
    ...source,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

function sourceFromRow(row: typeof planSources.$inferSelect): SourceArtifact {
  return sourceArtifactSchema.parse({
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  });
}

function jobToRow(job: CompileJob) {
  return {
    ...job,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function jobFromRow(row: typeof compileJobs.$inferSelect): CompileJob {
  return compileJobSchema.parse({
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  });
}

function generationToRow(
  input: { planArtifactId: string; compileJobId: string },
  generation: GenerationMetadata,
) {
  const metadata = generationMetadataSchema.parse(generation);
  return {
    id: metadata.id,
    planArtifactId: input.planArtifactId,
    compileJobId: input.compileJobId,
    stage: metadata.stage,
    metadataJson: serializeJson(metadata),
    createdAt: metadata.createdAt.toISOString(),
  };
}

function clarificationToRow(request: ClarificationRequest) {
  return {
    id: request.id,
    planArtifactId: request.planArtifactId,
    compileJobId: request.compileJobId,
    status: request.status,
    questionsJson: serializeJson(request.questions),
    answersJson: serializeJson(request.answers),
    expiresAt: request.expiresAt.toISOString(),
    createdAt: request.createdAt.toISOString(),
    answeredAt: request.answeredAt?.toISOString() ?? null,
  };
}

function clarificationFromRow(
  row: typeof clarificationRequests.$inferSelect,
): ClarificationRequest {
  return clarificationRequestSchema.parse({
    id: row.id,
    planArtifactId: row.planArtifactId,
    compileJobId: row.compileJobId,
    status: row.status,
    questions: parseJson(row.questionsJson),
    answers: parseJson(row.answersJson),
    expiresAt: new Date(row.expiresAt),
    createdAt: new Date(row.createdAt),
    answeredAt: row.answeredAt ? new Date(row.answeredAt) : null,
  });
}
