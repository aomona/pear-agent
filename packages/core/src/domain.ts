import { z } from "zod";

import {
  capabilityDefinitionSchema,
  executionModeSchema,
  type CapabilityDefinition,
  type ExecutionMode,
} from "./actor.js";
import { executionGoalSchema } from "./goal.js";
import type { ExecutionGoal } from "./goal.js";
import type { JsonValue } from "./world-state.js";

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
        // Reject unexpected schema keys so a definition cannot smuggle extra
        // fields past validation, then assert each expected schema identity.
        Object.keys(value as Record<string, unknown>).length === Object.keys(schemas).length &&
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

/**
 * Validates a runtime `domain_event` against Domain `schemas.events`.
 * `domainType` is the authoritative discriminator: when `payload` omits `type`
 * it is injected; when `payload` includes `type`, it must match `domainType`.
 */
export function parseDomainEvent<TEventsSchema extends z.ZodType>(
  eventsSchema: TEventsSchema,
  event: { domainType: string; payload: JsonValue },
): z.output<TEventsSchema> {
  if (
    typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload) &&
    "type" in event.payload
  ) {
    const payloadType = (event.payload as { type: unknown }).type;
    if (payloadType !== event.domainType) {
      throw new Error(
        `Domain event type mismatch: domainType ${JSON.stringify(event.domainType)} !== payload.type ${JSON.stringify(payloadType)}`,
      );
    }
    return eventsSchema.parse(event.payload);
  }

  const fields =
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
      ? event.payload
      : {};
  return eventsSchema.parse({ type: event.domainType, ...fields });
}
