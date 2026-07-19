import type {
  ExecutionGoal,
  ExecutionPlan,
  InterpretableSource,
  PlanCompilePhaseResult,
  SourceInterpreter,
} from "@pear-agent/core";
import { DEFAULT_AI_MAX_CALLS_PER_JOB, DEFAULT_AI_MAX_TOKENS_PER_JOB } from "@pear-agent/core";
import { DEFAULT_AI_MAX_ATTEMPTS_PER_PHASE } from "@pear-agent/core";

import type { AiPlanGenerator } from "./planner.js";

export type AiPlanCompilerInput = {
  artifact: {
    domainId: string;
    goal: ExecutionGoal;
  };
  sources: readonly InterpretableSource[];
  compileInput: unknown;
  clarificationAnswers?: Readonly<Record<string, string>>;
  context?: unknown;
  signal?: AbortSignal;
};

/** @deprecated Prefer PlanCompilePhaseResult from @pear-agent/core */
export type AiPlanCompilerResult = PlanCompilePhaseResult;

export type AiPlanCompiler = {
  compile(input: AiPlanCompilerInput): Promise<PlanCompilePhaseResult>;
};

export type CreateAiPlanCompilerOptions = {
  domainVersion: number;
  interpretationInstructions: string;
  planningInstructions: string;
  planningObjectives: readonly string[];
  interpreter: SourceInterpreter;
  planner: AiPlanGenerator;
  validateCompileInput?: (input: unknown) => unknown;
  validateNormalizedInput?: (input: unknown) => unknown;
  validatePlan?: (input: { plan: ExecutionPlan; normalizedInput: unknown }) => void | Promise<void>;
  maxModelCalls?: number;
  maxTokens?: number;
};

/** Compose the two AI phases without coupling either Core or Cloudflare to AI SDK. */
export function createAiPlanCompiler(options: CreateAiPlanCompilerOptions): AiPlanCompiler {
  return {
    async compile(input) {
      const maxModelCalls = options.maxModelCalls ?? DEFAULT_AI_MAX_CALLS_PER_JOB;
      const maxTokens = options.maxTokens ?? DEFAULT_AI_MAX_TOKENS_PER_JOB;
      if (maxModelCalls < 2) {
        throw new Error("AI compile requires a budget of at least two model calls");
      }
      const compileInput = options.validateCompileInput
        ? options.validateCompileInput(input.compileInput)
        : input.compileInput;
      const interpreted = await options.interpreter.interpret({
        domainId: input.artifact.domainId,
        domainVersion: options.domainVersion,
        compileInput,
        sources: input.sources,
        instructions: options.interpretationInstructions,
        ...(input.clarificationAnswers ? { clarificationAnswers: input.clarificationAnswers } : {}),
        context: input.context,
        ...(input.signal ? { signal: input.signal } : {}),
        maxAttempts: Math.min(DEFAULT_AI_MAX_ATTEMPTS_PER_PHASE, maxModelCalls - 1),
        maxOutputTokens: maxTokens,
      });
      assertBudget(
        interpreted.generation.attempt,
        interpreted.generation.totalTokens ?? 0,
        options,
      );
      if (interpreted.kind === "clarification_required") {
        return {
          kind: "clarification_required",
          questions: interpreted.questions,
          assumptions: interpreted.assumptions,
          interpretationGeneration: interpreted.generation,
        };
      }
      const normalizedInput = options.validateNormalizedInput
        ? options.validateNormalizedInput(interpreted.normalizedInput)
        : interpreted.normalizedInput;
      const remainingCalls = maxModelCalls - interpreted.generation.attempt;
      const remainingTokens = maxTokens - (interpreted.generation.totalTokens ?? 0);
      if (remainingCalls <= 0 || remainingTokens <= 0) {
        throw new Error("AI compile budget was exhausted before plan synthesis");
      }
      const planned = await options.planner.generatePlan({
        domainId: input.artifact.domainId,
        domainVersion: options.domainVersion,
        goal: input.artifact.goal,
        normalizedInput,
        sourceRefs: input.sources.map(({ artifact }) => ({ sourceId: artifact.id })),
        instructions: options.planningInstructions,
        objectives: options.planningObjectives,
        context: input.context,
        ...(input.signal ? { signal: input.signal } : {}),
        maxAttempts: Math.min(DEFAULT_AI_MAX_ATTEMPTS_PER_PHASE, remainingCalls),
        maxOutputTokens: remainingTokens,
      });
      assertBudget(
        interpreted.generation.attempt + planned.generation.attempt,
        (interpreted.generation.totalTokens ?? 0) + (planned.generation.totalTokens ?? 0),
        options,
      );
      await options.validatePlan?.({ plan: planned.plan, normalizedInput });
      return {
        kind: "ready",
        normalizedInput,
        assumptions: interpreted.assumptions,
        plan: planned.plan,
        interpretationGeneration: interpreted.generation,
        planGeneration: planned.generation,
      };
    },
  };
}

function assertBudget(
  modelCalls: number,
  totalTokens: number,
  options: Pick<CreateAiPlanCompilerOptions, "maxModelCalls" | "maxTokens">,
): void {
  const maxModelCalls = options.maxModelCalls ?? DEFAULT_AI_MAX_CALLS_PER_JOB;
  const maxTokens = options.maxTokens ?? DEFAULT_AI_MAX_TOKENS_PER_JOB;
  if (modelCalls > maxModelCalls) {
    throw new Error(`AI compile exceeded its ${maxModelCalls}-call budget`);
  }
  if (totalTokens > maxTokens) {
    throw new Error(`AI compile exceeded its ${maxTokens}-token budget`);
  }
}
