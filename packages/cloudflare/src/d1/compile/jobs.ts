import {
  clarificationRequestSchema,
  compileJobSchema,
  generationMetadataSchema,
  interpretationAssumptionSchema,
  type ClarificationQuestion,
  type ClarificationRequest,
  type CompileJob,
  type CompileJobStatus,
  type CompilePhase,
  type GenerationMetadata,
  type InterpretationAssumption,
} from "@pear-agent/core";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { parseJson, serializeJson } from "../../serialize.js";
import { isUniqueConstraintError } from "../repository.js";
import {
  clarificationRequests,
  compileJobs,
  generationRecords,
  interpretationArtifacts,
} from "../schema.js";
import { listSources } from "./sources.js";
import {
  ClarificationNotFoundError,
  CompileJobConflictError,
  CompileJobNotFoundError,
  clarificationFromRow,
  clarificationToRow,
  generationToRow,
  jobFromRow,
  jobToRow,
  type CompileRepoContext,
  type PlanArtifactInspector,
  type StoredInterpretation,
} from "./mappers.js";

export async function createJob(
  ctx: CompileRepoContext,
  planArtifactId: string,
  attempt = 1,
): Promise<CompileJob> {
  await expireClarifications(ctx, planArtifactId);
  const active = await ctx.db
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
    await ctx.db.insert(compileJobs).values(jobToRow(job));
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new CompileJobConflictError(`Plan artifact already has an active compile job`);
    }
    throw error;
  }
  return job;
}

export async function getJob(ctx: CompileRepoContext, id: string): Promise<CompileJob | null> {
  const rows = await ctx.db.select().from(compileJobs).where(eq(compileJobs.id, id)).limit(1);
  return rows[0] ? jobFromRow(rows[0]) : null;
}

export async function expireClarifications(
  ctx: CompileRepoContext,
  planArtifactId: string,
): Promise<void> {
  const expired = await ctx.db
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
    await ctx.db.batch([
      ctx.db
        .update(clarificationRequests)
        .set({ status: "expired" })
        .where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "pending"))),
      ctx.db
        .update(compileJobs)
        .set({ status: "expired", updatedAt: new Date().toISOString() })
        .where(and(eq(compileJobs.id, compileJobId), eq(compileJobs.status, "waiting"))),
    ]);
  }
}

export async function getActiveJob(
  ctx: CompileRepoContext,
  planArtifactId: string,
): Promise<CompileJob | null> {
  const rows = await ctx.db
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

export async function updateJob(
  ctx: CompileRepoContext,
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
  const existing = await getJob(ctx, id);
  if (!existing) throw new CompileJobNotFoundError(id);
  await ctx.db
    .update(compileJobs)
    .set({ ...update, updatedAt: new Date().toISOString() })
    .where(eq(compileJobs.id, id));
  const updated = await getJob(ctx, id);
  if (!updated) throw new CompileJobNotFoundError(id);
  return updated;
}

export async function transitionJob(
  ctx: CompileRepoContext,
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
  const rows = await ctx.db
    .update(compileJobs)
    .set({ ...update, updatedAt: new Date().toISOString() })
    .where(and(eq(compileJobs.id, id), inArray(compileJobs.status, [...fromStatuses])))
    .returning();
  if (!rows[0]) {
    const current = await getJob(ctx, id);
    if (!current) throw new CompileJobNotFoundError(id);
    throw new CompileJobConflictError(`Compile job is ${current.status}`);
  }
  return jobFromRow(rows[0]);
}

export async function saveInterpretation(
  ctx: CompileRepoContext,
  input: {
    planArtifactId: string;
    compileJobId: string;
    normalizedInput: unknown;
    assumptions: InterpretationAssumption[];
    generation: GenerationMetadata;
  },
): Promise<StoredInterpretation> {
  const existingRows = await ctx.db
    .select()
    .from(interpretationArtifacts)
    .where(eq(interpretationArtifacts.compileJobId, input.compileJobId))
    .limit(1);
  if (existingRows[0]) {
    // Workflow retries re-run AI for the same jobId; overwrite so plan and interpretation stay aligned.
    const row = existingRows[0];
    const assumptions = input.assumptions.map((item) => interpretationAssumptionSchema.parse(item));
    const generation = generationMetadataSchema.parse(input.generation);
    await ctx.db
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
  const revisions = await ctx.db
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
  await ctx.db.batch([
    ctx.db.insert(interpretationArtifacts).values({
      id: stored.id,
      planArtifactId: stored.planArtifactId,
      compileJobId: stored.compileJobId,
      revision: stored.revision,
      normalizedInputJson: serializeJson(stored.normalizedInput),
      assumptionsJson: serializeJson(stored.assumptions),
      generationJson: serializeJson(stored.generation),
      createdAt: createdAt.toISOString(),
    }),
    ctx.db.insert(generationRecords).values(generationToRow(input, input.generation)),
  ]);
  return stored;
}

export async function recordGeneration(
  ctx: CompileRepoContext,
  input: {
    planArtifactId: string;
    compileJobId: string;
    generation: GenerationMetadata;
  },
): Promise<void> {
  const existing = await ctx.db
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
  await ctx.db.insert(generationRecords).values(generationToRow(input, input.generation));
}

export async function createClarification(
  ctx: CompileRepoContext,
  input: {
    planArtifactId: string;
    compileJobId: string;
    questions: ClarificationQuestion[];
    expiresAt: Date;
  },
): Promise<ClarificationRequest> {
  const existing = await ctx.db
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
  await ctx.db.insert(clarificationRequests).values(clarificationToRow(request));
  return request;
}

export async function getClarificationForJob(
  ctx: CompileRepoContext,
  compileJobId: string,
): Promise<ClarificationRequest | null> {
  const rows = await ctx.db
    .select()
    .from(clarificationRequests)
    .where(eq(clarificationRequests.compileJobId, compileJobId))
    .limit(1);
  return rows[0] ? clarificationFromRow(rows[0]) : null;
}

export async function answerClarification(
  ctx: CompileRepoContext,
  planArtifactId: string,
  id: string,
  answers: Readonly<Record<string, string>>,
): Promise<ClarificationRequest> {
  const rows = await ctx.db
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
    await ctx.db.batch([
      ctx.db
        .update(clarificationRequests)
        .set({ status: "expired" })
        .where(and(eq(clarificationRequests.id, id), eq(clarificationRequests.status, "pending"))),
      ctx.db
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
  const [updated] = await ctx.db.batch([
    ctx.db
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
    ctx.db
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

export async function inspect(
  ctx: CompileRepoContext,
  planArtifactId: string,
): Promise<PlanArtifactInspector> {
  const [sources, jobs, interpretationRows, clarificationRows, generationRows] = await Promise.all([
    listSources(ctx, planArtifactId),
    ctx.db
      .select()
      .from(compileJobs)
      .where(eq(compileJobs.planArtifactId, planArtifactId))
      .orderBy(desc(compileJobs.createdAt)),
    ctx.db
      .select()
      .from(interpretationArtifacts)
      .where(eq(interpretationArtifacts.planArtifactId, planArtifactId))
      .orderBy(desc(interpretationArtifacts.revision)),
    ctx.db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.planArtifactId, planArtifactId))
      .orderBy(desc(clarificationRequests.createdAt)),
    ctx.db
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
