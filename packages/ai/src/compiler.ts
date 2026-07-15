import type {
  ExecutionGoal,
  ExecutionPlan,
  InterpretableSource,
  SourceInterpreter,
} from "@pear-agent/core";

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

export type AiPlanCompilerResult =
  | {
      kind: "clarification_required";
      questions: import("@pear-agent/core").ClarificationQuestion[];
      assumptions: import("@pear-agent/core").InterpretationAssumption[];
      interpretationGeneration: import("@pear-agent/core").GenerationMetadata;
    }
  | {
      kind: "ready";
      normalizedInput: unknown;
      assumptions: import("@pear-agent/core").InterpretationAssumption[];
      plan: ExecutionPlan;
      interpretationGeneration: import("@pear-agent/core").GenerationMetadata;
      planGeneration: import("@pear-agent/core").GenerationMetadata;
    };

export type AiPlanCompiler = {
  compile(input: AiPlanCompilerInput): Promise<AiPlanCompilerResult>;
};

export type CreateAiPlanCompilerOptions = {
  domainVersion: number;
  interpretationInstructions: string;
  planningInstructions: string;
  planningObjectives: readonly string[];
  interpreter: SourceInterpreter;
  planner: AiPlanGenerator;
  validateNormalizedInput?: (input: unknown) => unknown;
  validatePlan?: (input: { plan: ExecutionPlan; normalizedInput: unknown }) => void | Promise<void>;
};

/** Compose the two AI phases without coupling either Core or Cloudflare to AI SDK. */
export function createAiPlanCompiler(options: CreateAiPlanCompilerOptions): AiPlanCompiler {
  return {
    async compile(input) {
      const interpreted = await options.interpreter.interpret({
        domainId: input.artifact.domainId,
        domainVersion: options.domainVersion,
        compileInput: input.compileInput,
        sources: input.sources,
        instructions: options.interpretationInstructions,
        ...(input.clarificationAnswers ? { clarificationAnswers: input.clarificationAnswers } : {}),
        context: input.context,
      });
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
      const planned = await options.planner.generatePlan({
        domainId: input.artifact.domainId,
        domainVersion: options.domainVersion,
        goal: input.artifact.goal,
        normalizedInput,
        sourceRefs: input.sources.map(({ artifact }) => ({ sourceId: artifact.id })),
        instructions: options.planningInstructions,
        objectives: options.planningObjectives,
        context: input.context,
      });
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
