import type {
  ClarificationQuestion,
  ClarificationRequest,
  CompileJob,
  CompileJobStatus,
  CompilePhase,
  GenerationMetadata,
  InterpretationAssumption,
  SourceArtifact,
  SourceKind,
} from "@pear-agent/core";

import { createPearDatabase } from "./client.js";
import * as jobs from "./compile/jobs.js";
import {
  ClarificationNotFoundError,
  CompileJobConflictError,
  CompileJobNotFoundError,
  type CompileRepoContext,
  type PlanArtifactInspector,
  type StoredInterpretation,
} from "./compile/mappers.js";
import * as sources from "./compile/sources.js";

export type { PlanArtifactInspector, StoredInterpretation };
export { ClarificationNotFoundError, CompileJobConflictError, CompileJobNotFoundError };

export class D1CompileRepository {
  private readonly ctx: CompileRepoContext;

  constructor(d1: D1Database) {
    this.ctx = {
      d1,
      db: createPearDatabase(d1),
    };
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
    return sources.createSource(this.ctx, input);
  }

  async createSourceIfIdle(
    input: Parameters<D1CompileRepository["createSource"]>[0],
    maximumSources: number,
  ): Promise<SourceArtifact> {
    return sources.createSourceIfIdle(this.ctx, input, maximumSources);
  }

  async listSources(planArtifactId: string): Promise<SourceArtifact[]> {
    return sources.listSources(this.ctx, planArtifactId);
  }

  async markSourceDeleted(
    planArtifactId: string,
    sourceId: string,
  ): Promise<SourceArtifact | null> {
    return sources.markSourceDeleted(this.ctx, planArtifactId, sourceId);
  }

  async markSourceDeletingIfIdle(
    planArtifactId: string,
    sourceId: string,
  ): Promise<SourceArtifact | null> {
    return sources.markSourceDeletingIfIdle(this.ctx, planArtifactId, sourceId);
  }

  async finalizeSourceDeleted(planArtifactId: string, sourceId: string): Promise<void> {
    return sources.finalizeSourceDeleted(this.ctx, planArtifactId, sourceId);
  }

  async isSourceReferenced(planArtifactId: string, sourceId: string): Promise<boolean> {
    return sources.isSourceReferenced(this.ctx, planArtifactId, sourceId);
  }

  async createJob(planArtifactId: string, attempt = 1): Promise<CompileJob> {
    return jobs.createJob(this.ctx, planArtifactId, attempt);
  }

  async getJob(id: string): Promise<CompileJob | null> {
    return jobs.getJob(this.ctx, id);
  }

  async expireClarifications(planArtifactId: string): Promise<void> {
    return jobs.expireClarifications(this.ctx, planArtifactId);
  }

  async getActiveJob(planArtifactId: string): Promise<CompileJob | null> {
    return jobs.getActiveJob(this.ctx, planArtifactId);
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
    return jobs.updateJob(this.ctx, id, update);
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
    return jobs.transitionJob(this.ctx, id, fromStatuses, update);
  }

  async saveInterpretation(input: {
    planArtifactId: string;
    compileJobId: string;
    normalizedInput: unknown;
    assumptions: InterpretationAssumption[];
    generation: GenerationMetadata;
  }): Promise<StoredInterpretation> {
    return jobs.saveInterpretation(this.ctx, input);
  }

  async recordGeneration(input: {
    planArtifactId: string;
    compileJobId: string;
    generation: GenerationMetadata;
  }): Promise<void> {
    return jobs.recordGeneration(this.ctx, input);
  }

  async createClarification(input: {
    planArtifactId: string;
    compileJobId: string;
    questions: ClarificationQuestion[];
    expiresAt: Date;
  }): Promise<ClarificationRequest> {
    return jobs.createClarification(this.ctx, input);
  }

  async getClarificationForJob(compileJobId: string): Promise<ClarificationRequest | null> {
    return jobs.getClarificationForJob(this.ctx, compileJobId);
  }

  async answerClarification(
    planArtifactId: string,
    id: string,
    answers: Readonly<Record<string, string>>,
  ): Promise<ClarificationRequest> {
    return jobs.answerClarification(this.ctx, planArtifactId, id, answers);
  }

  async inspect(planArtifactId: string): Promise<PlanArtifactInspector> {
    return jobs.inspect(this.ctx, planArtifactId);
  }
}
