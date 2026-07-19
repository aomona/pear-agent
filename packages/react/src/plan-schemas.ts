import {
  clarificationRequestSchema,
  compileJobSchema,
  dateSchema,
  executionPlanSchema,
  generationMetadataSchema,
  interpretationAssumptionSchema,
  planArtifactStatusSchema,
  sourceArtifactSchema,
} from "@pear-agent/core";
import { z } from "zod";

const optionalTitle = z.preprocess(
  (value) => (value === null || value === "" ? undefined : value),
  z.string().min(1).max(160).optional(),
);

export const planListItemSchema = z.object({
  id: z.string().min(1),
  domainId: z.string().min(1),
  status: planArtifactStatusSchema,
  title: optionalTitle,
  version: z.number().int().positive(),
  goalId: z.string().min(1),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

export const planArtifactDetailSchema = z.object({
  id: z.string().min(1),
  domainId: z.string().min(1),
  status: planArtifactStatusSchema,
  title: optionalTitle,
  version: z.number().int().positive(),
  goal: z.unknown(),
  currentPlan: executionPlanSchema(z.unknown()),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  normalizedInput: z.unknown().optional(),
  ownerActorId: z.string().nullable().optional(),
});

export const planArtifactInspectorSchema = z.object({
  sources: z.array(sourceArtifactSchema),
  jobs: z.array(compileJobSchema),
  interpretations: z.array(
    z.object({
      id: z.string().min(1),
      planArtifactId: z.string().min(1),
      compileJobId: z.string().min(1),
      revision: z.number().int().positive(),
      normalizedInput: z.unknown(),
      assumptions: z.array(interpretationAssumptionSchema),
      generation: generationMetadataSchema,
      createdAt: dateSchema,
    }),
  ),
  clarifications: z.array(clarificationRequestSchema),
  generations: z.array(generationMetadataSchema),
});

export const planEditProposalSchema = z.object({
  id: z.string().min(1),
  planArtifactId: z.string().min(1),
  baseVersion: z.number().int().positive(),
  request: z.string().min(1),
  candidatePlan: executionPlanSchema(z.unknown()),
  diff: z.object({
    addedStepIds: z.array(z.string()),
    removedStepIds: z.array(z.string()),
    updatedStepIds: z.array(z.string()),
    fieldChanges: z.array(
      z.object({ stepId: z.string(), field: z.string(), before: z.unknown(), after: z.unknown() }),
    ),
    durationDeltaSeconds: z.number(),
  }),
  status: z.enum(["pending", "applied", "rejected", "stale"]),
  createdByActorId: z.string().min(1),
  createdAt: dateSchema,
  appliedAt: dateSchema.nullable(),
});
