import type { FreeTextFieldResolver, PlanImprover } from "@pear-agent/core";

import type { AuthorizeFn } from "../authorize.js";
import type { PearEnv } from "../env.js";
import type { PlanGenerator } from "../planner.js";

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
  normalizeDomainInput?: NormalizeDomainInput;
  resolveDomainFreeTextField?: ResolveDomainFreeTextField;
};

export type PlanLibraryHostPorts = {
  generator: { resolve(env: PearEnv): PlanGenerator };
  freeText: { resolve(env: PearEnv): FreeTextFieldResolver | undefined };
  improvement: { resolve(env: PearEnv): PlanImprover | undefined };
  domain: {
    normalizeInput?: NormalizeDomainInput;
    resolveFreeTextField?: ResolveDomainFreeTextField;
  };
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
    },
    domain: {
      ...(options.normalizeDomainInput ? { normalizeInput: options.normalizeDomainInput } : {}),
      ...(options.resolveDomainFreeTextField
        ? { resolveFreeTextField: options.resolveDomainFreeTextField }
        : {}),
    },
  };
}
