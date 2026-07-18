import { sourceArtifactSchema, type SourceArtifact, type SourceKind } from "@pear-agent/core";
import { and, eq, sql } from "drizzle-orm";

import { parseJson } from "../../serialize.js";
import {
  clarificationRequests,
  compileJobs,
  interpretationArtifacts,
  planSources,
} from "../schema.js";
import {
  CompileJobConflictError,
  jobFromRow,
  sourceFromRow,
  sourceToRow,
  type CompileRepoContext,
} from "./mappers.js";

export type CreateSourceInput = {
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
};

async function getActiveJob(
  ctx: CompileRepoContext,
  planArtifactId: string,
): Promise<ReturnType<typeof jobFromRow> | null> {
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

export async function createSource(
  ctx: CompileRepoContext,
  input: CreateSourceInput,
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
  await ctx.db.insert(planSources).values(sourceToRow(source));
  return source;
}

export async function createSourceIfIdle(
  ctx: CompileRepoContext,
  input: CreateSourceInput,
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
  const result = await ctx.d1
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
    if (await getActiveJob(ctx, input.planArtifactId)) {
      throw new CompileJobConflictError("Sources cannot change during an active compile");
    }
    throw new CompileJobConflictError(`A plan may have at most ${maximumSources} sources`);
  }
  return source;
}

export async function listSources(
  ctx: CompileRepoContext,
  planArtifactId: string,
): Promise<SourceArtifact[]> {
  const rows = await ctx.db
    .select()
    .from(planSources)
    .where(eq(planSources.planArtifactId, planArtifactId))
    .orderBy(planSources.createdAt);
  return rows.map(sourceFromRow);
}

export async function markSourceDeleted(
  ctx: CompileRepoContext,
  planArtifactId: string,
  sourceId: string,
): Promise<SourceArtifact | null> {
  const rows = await ctx.db
    .select()
    .from(planSources)
    .where(and(eq(planSources.planArtifactId, planArtifactId), eq(planSources.id, sourceId)))
    .limit(1);
  if (!rows[0]) return null;
  const updatedAt = new Date();
  await ctx.db
    .update(planSources)
    .set({ status: "deleted", updatedAt: updatedAt.toISOString() })
    .where(eq(planSources.id, sourceId));
  return sourceArtifactSchema.parse({ ...rows[0], status: "deleted", updatedAt });
}

export async function markSourceDeletingIfIdle(
  ctx: CompileRepoContext,
  planArtifactId: string,
  sourceId: string,
): Promise<SourceArtifact | null> {
  const rows = await ctx.db
    .select()
    .from(planSources)
    .where(and(eq(planSources.planArtifactId, planArtifactId), eq(planSources.id, sourceId)))
    .limit(1);
  if (!rows[0] || rows[0].status === "deleted") return null;
  const updatedAt = new Date();
  const result = await ctx.d1
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
    if (await getActiveJob(ctx, planArtifactId)) {
      throw new CompileJobConflictError("Sources cannot change during an active compile");
    }
    return null;
  }
  return sourceArtifactSchema.parse({ ...rows[0], status: "deleting", updatedAt });
}

export async function finalizeSourceDeleted(
  ctx: CompileRepoContext,
  planArtifactId: string,
  sourceId: string,
): Promise<void> {
  await ctx.db
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

export async function isSourceReferenced(
  ctx: CompileRepoContext,
  planArtifactId: string,
  sourceId: string,
): Promise<boolean> {
  const [interpretationRows, clarificationRows] = await Promise.all([
    ctx.db
      .select({ assumptionsJson: interpretationArtifacts.assumptionsJson })
      .from(interpretationArtifacts)
      .where(eq(interpretationArtifacts.planArtifactId, planArtifactId)),
    ctx.db
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
