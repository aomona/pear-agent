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
import { and, desc, eq, sql } from "drizzle-orm";

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

export class CompileJobConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "CompileJobConflictError";
  }
}

export class D1CompileRepository {
  private readonly db: PearDatabase;

  constructor(d1: D1Database) {
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

  async createJob(planArtifactId: string, attempt = 1): Promise<CompileJob> {
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

  async saveInterpretation(input: {
    planArtifactId: string;
    compileJobId: string;
    normalizedInput: unknown;
    assumptions: InterpretationAssumption[];
    generation: GenerationMetadata;
  }): Promise<StoredInterpretation> {
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
    await this.db.insert(generationRecords).values(generationToRow(input, input.generation));
  }

  async createClarification(input: {
    planArtifactId: string;
    compileJobId: string;
    questions: ClarificationQuestion[];
    expiresAt: Date;
  }): Promise<ClarificationRequest> {
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

  async answerClarification(
    id: string,
    answers: Readonly<Record<string, string>>,
  ): Promise<ClarificationRequest> {
    const rows = await this.db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.id, id))
      .limit(1);
    const current = rows[0] ? clarificationFromRow(rows[0]) : null;
    if (!current) throw new CompileJobNotFoundError(id);
    if (current.status !== "pending") {
      throw new CompileJobConflictError(`Clarification request is ${current.status}`);
    }
    if (current.expiresAt <= new Date()) {
      await this.db
        .update(clarificationRequests)
        .set({ status: "expired" })
        .where(eq(clarificationRequests.id, id));
      throw new CompileJobConflictError("Clarification request has expired");
    }
    const answeredAt = new Date();
    await this.db
      .update(clarificationRequests)
      .set({
        status: "answered",
        answersJson: serializeJson(answers),
        answeredAt: answeredAt.toISOString(),
      })
      .where(eq(clarificationRequests.id, id));
    return clarificationRequestSchema.parse({
      ...current,
      status: "answered",
      answers,
      answeredAt,
    });
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
