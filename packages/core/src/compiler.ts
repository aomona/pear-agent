import { z } from "zod";

import { dateSchema } from "./date.js";
import type { ExecutionGoal } from "./goal.js";
import type { ExecutionPlan } from "./plan.js";
import type { PlanImproveResult } from "./plan-improve.js";
import type { PlanPatch } from "./replan.js";

export const sourceKindSchema = z.enum(["text", "url", "file"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceArtifactStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "deleting",
  "deleted",
]);
export type SourceArtifactStatus = z.infer<typeof sourceArtifactStatusSchema>;

export const sourceArtifactSchema = z
  .object({
    id: z.string().min(1),
    planArtifactId: z.string().min(1),
    kind: sourceKindSchema,
    status: sourceArtifactStatusSchema,
    label: z.string().trim().min(1).max(200),
    mediaType: z.string().trim().min(1).max(200),
    byteSize: z.number().int().nonnegative(),
    checksumSha256: z.string().min(1),
    sourceUrl: z.url().nullable().default(null),
    rawObjectKey: z.string().min(1).nullable().default(null),
    extractedObjectKey: z.string().min(1).nullable().default(null),
    createdByActorId: z.string().min(1),
    createdAt: dateSchema,
    updatedAt: dateSchema,
  })
  .strict();
export type SourceArtifact = z.infer<typeof sourceArtifactSchema>;

export const sourceReferenceSchema = z
  .object({
    sourceId: z.string().min(1),
    fragment: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const interpretationAssumptionSchema = z
  .object({
    id: z.string().min(1),
    summary: z.string().trim().min(1).max(1_000),
    sourceRefs: z.array(sourceReferenceSchema).max(100).default([]),
  })
  .strict();
export type InterpretationAssumption = z.infer<typeof interpretationAssumptionSchema>;

export const clarificationQuestionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().trim().min(1).max(2_000),
    reason: z.string().trim().min(1).max(2_000),
    sourceRefs: z.array(sourceReferenceSchema).max(100).default([]),
  })
  .strict();
export type ClarificationQuestion = z.infer<typeof clarificationQuestionSchema>;

export const clarificationStatusSchema = z.enum(["pending", "answered", "expired"]);
export type ClarificationStatus = z.infer<typeof clarificationStatusSchema>;

export const clarificationRequestSchema = z
  .object({
    id: z.string().min(1),
    planArtifactId: z.string().min(1),
    compileJobId: z.string().min(1),
    status: clarificationStatusSchema,
    questions: z.array(clarificationQuestionSchema).min(1).max(100),
    answers: z.record(z.string(), z.string().trim().min(1).max(10_000)).default({}),
    expiresAt: dateSchema,
    createdAt: dateSchema,
    answeredAt: dateSchema.nullable().default(null),
  })
  .strict();
export type ClarificationRequest = z.infer<typeof clarificationRequestSchema>;

export const generationStageSchema = z.enum(["interpret", "plan", "edit", "assess", "replan"]);
export type GenerationStage = z.infer<typeof generationStageSchema>;

export const generationMetadataSchema = z
  .object({
    id: z.string().min(1),
    stage: generationStageSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
    inputTokens: z.number().int().nonnegative().nullable().default(null),
    outputTokens: z.number().int().nonnegative().nullable().default(null),
    totalTokens: z.number().int().nonnegative().nullable().default(null),
    attempt: z.number().int().positive(),
    warnings: z.array(z.string().max(2_000)).max(100).default([]),
    createdAt: dateSchema,
  })
  .strict();
export type GenerationMetadata = z.infer<typeof generationMetadataSchema>;

export const compilePhaseSchema = z.enum([
  "queued",
  "ingest",
  "interpret",
  "awaiting_clarification",
  "plan",
  "validate",
  "review",
]);
export type CompilePhase = z.infer<typeof compilePhaseSchema>;

export const compileJobStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type CompileJobStatus = z.infer<typeof compileJobStatusSchema>;

export const compileJobSchema = z
  .object({
    id: z.string().min(1),
    planArtifactId: z.string().min(1),
    workflowInstanceId: z.string().min(1).nullable().default(null),
    phase: compilePhaseSchema,
    status: compileJobStatusSchema,
    attempt: z.number().int().positive(),
    modelCalls: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    error: z.string().max(4_000).nullable().default(null),
    createdAt: dateSchema,
    updatedAt: dateSchema,
  })
  .strict();
export type CompileJob = z.infer<typeof compileJobSchema>;

export const planChangeCauseRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("source"), sourceId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("user_instruction"), instructionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("clarification"), clarificationId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("runtime_event"), eventId: z.string().min(1) }).strict(),
]);
export type PlanChangeCauseRef = z.infer<typeof planChangeCauseRefSchema>;

export type InterpretableSource = {
  artifact: SourceArtifact;
  extractedText?: string;
  data?: Uint8Array;
};

export type SourceInterpretInput = {
  domainId: string;
  domainVersion: number;
  compileInput: unknown;
  sources: readonly InterpretableSource[];
  instructions: string;
  clarificationAnswers?: Readonly<Record<string, string>>;
  context?: unknown;
  signal?: AbortSignal;
  maxAttempts?: number;
  maxOutputTokens?: number;
};

export type SourceInterpretResult<TNormalizedInput = unknown> =
  | {
      kind: "ready";
      normalizedInput: TNormalizedInput;
      assumptions: InterpretationAssumption[];
      generation: GenerationMetadata;
    }
  | {
      kind: "clarification_required";
      questions: ClarificationQuestion[];
      assumptions: InterpretationAssumption[];
      generation: GenerationMetadata;
    };

export type SourceInterpreter<TNormalizedInput = unknown> = {
  interpret(input: SourceInterpretInput): Promise<SourceInterpretResult<TNormalizedInput>>;
};

export type PlanEditorInput = {
  domainId: string;
  basePlan: ExecutionPlan;
  goal: ExecutionGoal;
  request: string;
  normalizedInput: unknown;
  sourceRefs: readonly SourceReference[];
  context?: unknown;
};

export type PlanEditor = {
  edit(input: PlanEditorInput): Promise<PlanImproveResult>;
};

export type ReplanGeneratorInput = {
  domainId: string;
  instructions: string;
  plan: ExecutionPlan;
  normalizedInput: unknown;
  assessment: unknown;
  affectedStepIds: readonly string[];
  causeRefs: readonly PlanChangeCauseRef[];
  baseLastEventId: string | null;
  context?: unknown;
};

export type ReplanGenerator = {
  generatePatch(input: ReplanGeneratorInput): Promise<PlanPatch>;
};

export const DEFAULT_AI_MAX_ATTEMPTS_PER_PHASE = 3;
export const DEFAULT_AI_MAX_CALLS_PER_JOB = 12;
export const DEFAULT_AI_MAX_TOKENS_PER_JOB = 1_000_000;
export const DEFAULT_AI_CALL_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_CLARIFICATION_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_REALTIME_OBSERVATION_CONFIDENCE = 0.8;
