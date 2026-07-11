import { z } from "zod";

export const executionModeSchema = z.enum(["automatic", "confirm", "suggest"]);

export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const riskLevelSchema = z.enum(["low", "medium", "high"]);

export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const executionActorSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["human", "agent", "system"]),
});

export type ExecutionActor = z.infer<typeof executionActorSchema>;

export const stepAssignmentSchema = z.object({
  stepId: z.string().min(1),
  actorIds: z.array(z.string().min(1)).min(1),
});

export type StepAssignment = z.infer<typeof stepAssignmentSchema>;

export interface CapabilityDefinition<TInput, TOutput, TContext = unknown> {
  id: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  executionMode: ExecutionMode;
  riskLevel: RiskLevel;
  execute(input: TInput, context: TContext): Promise<TOutput>;
}

export function capabilityDefinitionSchema<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(inputSchema: TInputSchema, outputSchema: TOutputSchema) {
  return z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    inputSchema: z.custom<TInputSchema>((value) => value === inputSchema),
    outputSchema: z.custom<TOutputSchema>((value) => value === outputSchema),
    executionMode: executionModeSchema,
    riskLevel: riskLevelSchema,
    execute: z.function(),
  });
}

export function resolveExecutionMode({
  configuredMode,
  riskLevel,
}: {
  configuredMode: ExecutionMode;
  riskLevel: RiskLevel;
}): ExecutionMode {
  return configuredMode === "automatic" && riskLevel === "high" ? "confirm" : configuredMode;
}
