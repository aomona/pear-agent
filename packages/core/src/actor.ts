import { z } from "zod";

export type ExecutionMode = "automatic" | "confirm" | "suggest";

export type RiskLevel = "low" | "medium" | "high";

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

export function resolveExecutionMode({
  configuredMode,
  riskLevel,
}: {
  configuredMode: ExecutionMode;
  riskLevel: RiskLevel;
}): ExecutionMode {
  return configuredMode === "automatic" && riskLevel === "high" ? "confirm" : configuredMode;
}
