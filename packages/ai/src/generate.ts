import {
  DEFAULT_AI_CALL_TIMEOUT_MS,
  DEFAULT_AI_MAX_ATTEMPTS_PER_PHASE,
  generationMetadataSchema,
  type GenerationMetadata,
  type GenerationStage,
} from "@pear-agent/core";
import {
  generateText,
  Output,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
} from "ai";
import { z } from "zod";

export type StructuredGenerationRequest<TSchema extends z.ZodType> = {
  model: LanguageModel;
  schema: TSchema;
  stage: GenerationStage;
  system: string;
  prompt: string | ModelMessage[];
  promptVersion: string;
  schemaVersion: string;
  maxAttempts?: number;
  timeoutMs?: number;
};

export type StructuredGenerationResult<T> = {
  output: T;
  metadata: GenerationMetadata;
};

export type StructuredGenerator = <TSchema extends z.ZodType>(
  request: StructuredGenerationRequest<TSchema>,
) => Promise<StructuredGenerationResult<z.output<TSchema>>>;

function modelIdentity(model: LanguageModel): { provider: string; model: string } {
  if (typeof model === "string") {
    const [provider = "gateway", ...rest] = model.split("/");
    return { provider, model: rest.join("/") || model };
  }
  const value = model as { provider?: string; modelId?: string };
  return { provider: value.provider ?? "unknown", model: value.modelId ?? "unknown" };
}

function usageValue(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

function metadata(input: {
  request: StructuredGenerationRequest<z.ZodType>;
  usage: LanguageModelUsage;
  attempt: number;
  warnings: readonly unknown[];
}): GenerationMetadata {
  const identity = modelIdentity(input.request.model);
  return generationMetadataSchema.parse({
    id: crypto.randomUUID(),
    stage: input.request.stage,
    provider: identity.provider,
    model: identity.model,
    promptVersion: input.request.promptVersion,
    schemaVersion: input.request.schemaVersion,
    inputTokens: usageValue(input.usage.inputTokens),
    outputTokens: usageValue(input.usage.outputTokens),
    totalTokens: usageValue(input.usage.totalTokens),
    attempt: input.attempt,
    warnings: input.warnings.map((warning) => String(warning)),
    createdAt: new Date(),
  });
}

export const generateStructured: StructuredGenerator = async <TSchema extends z.ZodType>(
  request: StructuredGenerationRequest<TSchema>,
): Promise<StructuredGenerationResult<z.output<TSchema>>> => {
  const maxAttempts = request.maxAttempts ?? DEFAULT_AI_MAX_ATTEMPTS_PER_PHASE;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await generateText({
        model: request.model,
        output: Output.object({ schema: request.schema }),
        system: request.system,
        prompt: request.prompt,
        maxRetries: 0,
        temperature: 0,
        abortSignal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_AI_CALL_TIMEOUT_MS),
      });
      return {
        output: request.schema.parse(result.output),
        metadata: metadata({
          request,
          usage: result.usage,
          attempt,
          warnings: result.warnings ?? [],
        }),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`AI ${request.stage} generation failed after ${maxAttempts} attempts`, {
    cause: lastError,
  });
};
