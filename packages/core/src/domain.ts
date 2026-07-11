import { z } from "zod";

import type { CapabilityDefinition, ExecutionMode } from "./actor.js";
import type { ExecutionGoal } from "./goal.js";

export type DomainSchemas = {
  input: z.ZodType;
  normalizedInput: z.ZodType;
  stepData: z.ZodType;
  worldState: z.ZodType;
  events: z.ZodType;
};

export interface ExecutionDomainDefinition<
  TSchemas extends DomainSchemas,
  TId extends string = string,
  TVersion extends number = number,
  TCapabilities extends readonly CapabilityDefinition<any, any, any>[] =
    readonly CapabilityDefinition<any, any, any>[],
> {
  id: TId;
  version: TVersion;
  schemas: TSchemas;
  normalizeInput(
    input: z.output<TSchemas["input"]>,
  ): Promise<z.output<TSchemas["normalizedInput"]>>;
  planning: {
    instructions: string;
    objectives: readonly [string, ...string[]];
  };
  replanning: {
    instructions: string;
    defaultMode: ExecutionMode;
  };
  capabilities: TCapabilities;
  completionPolicy: ExecutionGoal["completionPolicy"];
}

export function defineDomain<
  const TSchemas extends DomainSchemas,
  const TId extends string,
  const TVersion extends number,
  const TCapabilities extends readonly CapabilityDefinition<any, any, any>[],
>(
  definition: ExecutionDomainDefinition<TSchemas, TId, TVersion, TCapabilities>,
): ExecutionDomainDefinition<TSchemas, TId, TVersion, TCapabilities> {
  if (definition.planning.objectives.length === 0) {
    throw new Error("Domain planning objectives must not be empty");
  }

  return {
    ...definition,
    normalizeInput: async (input) => {
      const normalizedInput = await definition.normalizeInput(input);
      return definition.schemas.normalizedInput.parseAsync(normalizedInput) as Promise<
        z.output<TSchemas["normalizedInput"]>
      >;
    },
  };
}
