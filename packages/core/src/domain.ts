import { z } from "zod";

import {
  capabilityDefinitionSchema,
  executionModeSchema,
  type CapabilityDefinition,
  type ExecutionMode,
} from "./actor.js";
import { executionGoalSchema } from "./goal.js";
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

export function executionDomainDefinitionSchema<
  const TSchemas extends DomainSchemas,
  const TCapabilitySchemas extends readonly z.ZodType[],
>(schemas: TSchemas, capabilitySchemas: TCapabilitySchemas) {
  return z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    schemas: z.custom<TSchemas>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        Object.entries(schemas).every(
          ([key, schema]) => (value as Record<string, unknown>)[key] === schema,
        ),
    ),
    normalizeInput: z.function(),
    planning: z.object({
      instructions: z.string().min(1),
      objectives: z.tuple([z.string().min(1)], z.string().min(1)),
    }),
    replanning: z.object({
      instructions: z.string().min(1),
      defaultMode: executionModeSchema,
    }),
    capabilities: z.custom<{
      [K in keyof TCapabilitySchemas]: z.output<TCapabilitySchemas[K]>;
    }>((value) => {
      if (!Array.isArray(value) || value.length !== capabilitySchemas.length) return false;
      return capabilitySchemas.every((schema, index) => schema.safeParse(value[index]).success);
    }),
    completionPolicy: executionGoalSchema.shape.completionPolicy,
  });
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

  const capabilitySchemas = definition.capabilities.map(({ inputSchema, outputSchema }) =>
    capabilityDefinitionSchema(inputSchema, outputSchema),
  );
  executionDomainDefinitionSchema(definition.schemas, capabilitySchemas).parse(definition);

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
