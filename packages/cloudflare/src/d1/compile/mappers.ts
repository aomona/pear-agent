import {
  clarificationRequestSchema,
  compileJobSchema,
  generationMetadataSchema,
  sourceArtifactSchema,
  type ClarificationRequest,
  type CompileJob,
  type GenerationMetadata,
  type InterpretationAssumption,
  type SourceArtifact,
} from "@pear-agent/core";

import { parseJson, serializeJson } from "../../serialize.js";
import type { PearDatabase } from "../client.js";
import { clarificationRequests, compileJobs, planSources } from "../schema.js";

export type CompileRepoContext = {
  d1: D1Database;
  db: PearDatabase;
};

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

export function sourceToRow(source: SourceArtifact) {
  return {
    ...source,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

export function sourceFromRow(row: typeof planSources.$inferSelect): SourceArtifact {
  return sourceArtifactSchema.parse({
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  });
}

export function jobToRow(job: CompileJob) {
  return {
    ...job,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function jobFromRow(row: typeof compileJobs.$inferSelect): CompileJob {
  return compileJobSchema.parse({
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  });
}

export function generationToRow(
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

export function clarificationToRow(request: ClarificationRequest) {
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

export function clarificationFromRow(
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
