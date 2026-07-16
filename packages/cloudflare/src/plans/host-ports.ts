import type {
  ClarificationQuestion,
  ExecutionPlan,
  FreeTextFieldResolver,
  GenerationMetadata,
  InterpretationAssumption,
  PlanImprover,
  InterpretableSource,
} from "@pear-agent/core";

import type { AuthorizeFn } from "../authorize.js";
import type { PearEnv } from "../env.js";
import type { PlanGenerator } from "../planner.js";
import type { PearRequestContext } from "../context.js";
import type { StoredPlanArtifact } from "../d1/plan-repository.js";

export type PlanCompileRuntimeResult =
  | {
      kind: "clarification_required";
      questions: ClarificationQuestion[];
      assumptions: InterpretationAssumption[];
      interpretationGeneration: GenerationMetadata;
    }
  | {
      kind: "ready";
      normalizedInput: unknown;
      assumptions: InterpretationAssumption[];
      plan: ExecutionPlan;
      interpretationGeneration: GenerationMetadata;
      planGeneration: GenerationMetadata;
    };

/** Host-composed AI runtime. Cloudflare persists and orchestrates; the host selects models/domains. */
export type PlanCompileRuntime = {
  compile(input: {
    artifact: StoredPlanArtifact;
    sources: readonly InterpretableSource[];
    compileInput: unknown;
    clarificationAnswers?: Readonly<Record<string, string>>;
    context: PearRequestContext;
    signal?: AbortSignal;
  }): Promise<PlanCompileRuntimeResult>;
};

type NormalizeDomainInput = (input: {
  domainId: string;
  input: unknown;
  freeTextResolver?: FreeTextFieldResolver;
  context: unknown;
}) => Promise<unknown>;

type ResolveDomainFreeTextField = (input: {
  domainId: string;
  field: string;
  freeText: string;
  freeTextResolver?: FreeTextFieldResolver;
  context: unknown;
}) => Promise<unknown>;

export type ValidatePlanEdit = (input: {
  domainId: string;
  plan: ExecutionPlan;
  normalizedInput?: unknown;
}) => void | Promise<void>;

/**
 * Public host-injection surface. Static ports support tests and simple Workers;
 * `create*` factories take precedence when a port needs per-request env bindings.
 */
export type PlanLibraryOptions = {
  authorize: AuthorizeFn;
  planGenerator: PlanGenerator;
  createPlanGenerator?: (env: PearEnv) => PlanGenerator;
  freeTextResolver?: FreeTextFieldResolver;
  createFreeTextResolver?: (env: PearEnv) => FreeTextFieldResolver | undefined;
  planImprover?: PlanImprover;
  createPlanImprover?: (env: PearEnv) => PlanImprover | undefined;
  validatePlanEdit?: ValidatePlanEdit;
  normalizeDomainInput?: NormalizeDomainInput;
  resolveDomainFreeTextField?: ResolveDomainFreeTextField;
  compileRuntime?: PlanCompileRuntime;
  createCompileRuntime?: (env: PearEnv) => PlanCompileRuntime | undefined;
};

export type PlanLibraryHostPorts = {
  generator: { resolve(env: PearEnv): PlanGenerator };
  freeText: { resolve(env: PearEnv): FreeTextFieldResolver | undefined };
  improvement: {
    resolve(env: PearEnv): PlanImprover | undefined;
    validate?: ValidatePlanEdit;
  };
  domain: {
    normalizeInput?: NormalizeDomainInput;
    resolveFreeTextField?: ResolveDomainFreeTextField;
  };
  compile: { resolve(env: PearEnv): PlanCompileRuntime | undefined };
};

function resolveOptionalEnvPort<T>(
  create: ((env: PearEnv) => T | undefined) | undefined,
  fallback: T | undefined,
  env: PearEnv,
): T | undefined {
  return create?.(env) ?? fallback;
}

/** Normalize the stable public options into grouped ports used by route modules. */
export function createPlanLibraryHostPorts(options: PlanLibraryOptions): PlanLibraryHostPorts {
  return {
    generator: { resolve: (env) => options.createPlanGenerator?.(env) ?? options.planGenerator },
    freeText: {
      resolve: (env) =>
        resolveOptionalEnvPort(options.createFreeTextResolver, options.freeTextResolver, env),
    },
    improvement: {
      resolve: (env) =>
        resolveOptionalEnvPort(options.createPlanImprover, options.planImprover, env),
      ...(options.validatePlanEdit ? { validate: options.validatePlanEdit } : {}),
    },
    domain: {
      ...(options.normalizeDomainInput ? { normalizeInput: options.normalizeDomainInput } : {}),
      ...(options.resolveDomainFreeTextField
        ? { resolveFreeTextField: options.resolveDomainFreeTextField }
        : {}),
    },
    compile: {
      resolve: (env) =>
        resolveOptionalEnvPort(options.createCompileRuntime, options.compileRuntime, env),
    },
  };
}
