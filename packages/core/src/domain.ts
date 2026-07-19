import { z } from "zod";

import {
  capabilityDefinitionSchema,
  executionModeSchema,
  type CapabilityDefinition,
  type ExecutionMode,
} from "./actor.js";
import type { NormalizeInputContext } from "./free-text.js";
import { executionGoalSchema } from "./goal.js";
import type { ExecutionGoal } from "./goal.js";
import type { ExecutionPlan } from "./plan.js";
import type { WorldState } from "./world-state.js";
import type { JsonValue } from "./world-state.js";

export type DomainSchemas = {
  input: z.ZodType;
  normalizedInput: z.ZodType;
  stepData: z.ZodType;
  worldState: z.ZodType;
  events: z.ZodType;
};

export type AiDomainSchemas = {
  compileInput: z.ZodType;
  normalizedInput: z.ZodType;
  stepData: z.ZodType;
  worldState: z.ZodType;
  events: z.ZodType;
};

export type DomainPlanValidation = {
  valid: boolean;
  issues: readonly string[];
};

export interface AiExecutionDomainDefinition<
  TSchemas extends AiDomainSchemas,
  TId extends string = string,
  TVersion extends number = number,
  TCapabilities extends readonly CapabilityDefinition<any, any, any>[] =
    readonly CapabilityDefinition<any, any, any>[],
> {
  id: TId;
  version: TVersion;
  schemas: TSchemas;
  interpretation: { instructions: string };
  planning: {
    instructions: string;
    objectives: readonly [string, ...string[]];
    validatePlan(
      plan: ExecutionPlan<z.output<TSchemas["stepData"]>>,
      normalizedInput: z.output<TSchemas["normalizedInput"]>,
    ): DomainPlanValidation | Promise<DomainPlanValidation>;
    reconcilePlan?(
      plan: ExecutionPlan<z.output<TSchemas["stepData"]>>,
      normalizedInput: z.output<TSchemas["normalizedInput"]>,
    ): ExecutionPlan<z.output<TSchemas["stepData"]>>;
  };
  replanning: {
    instructions: string;
    defaultMode: ExecutionMode;
    reconcileWorldState(
      plan: ExecutionPlan<z.output<TSchemas["stepData"]>>,
      worldState: WorldState,
    ): WorldState;
  };
  realtime: { instructions: string; defaultLocale: string };
  capabilities: TCapabilities;
  completionPolicy: ExecutionGoal["completionPolicy"];
}

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
  /**
   * Coerce Domain input → normalizedInput.
   * Fields may arrive as free-text envelopes; use `ctx.freeTextResolver` (often LLM)
   * plus deterministic parsers. Output is always re-validated by {@link defineDomain}.
   */
  normalizeInput(
    input: z.output<TSchemas["input"]>,
    ctx?: NormalizeInputContext,
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
    normalizeInput: async (input, ctx) => {
      const normalizedInput = await definition.normalizeInput(input, ctx);
      return definition.schemas.normalizedInput.parseAsync(normalizedInput) as Promise<
        z.output<TSchemas["normalizedInput"]>
      >;
    },
  };
}

/**
 * AI-native Domain definition. The Domain declares schemas, instructions and
 * deterministic invariants; SourceInterpreter/Planner implementations are injected by the host.
 */
export function defineAiDomain<
  const TSchemas extends AiDomainSchemas,
  const TId extends string,
  const TVersion extends number,
  const TCapabilities extends readonly CapabilityDefinition<any, any, any>[],
>(
  definition: AiExecutionDomainDefinition<TSchemas, TId, TVersion, TCapabilities>,
): AiExecutionDomainDefinition<TSchemas, TId, TVersion, TCapabilities> {
  if (definition.id.trim().length === 0) throw new Error("Domain id must not be empty");
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new Error("Domain version must be a positive integer");
  }
  if (definition.interpretation.instructions.trim().length === 0) {
    throw new Error("Domain interpretation instructions must not be empty");
  }
  if (definition.planning.instructions.trim().length === 0) {
    throw new Error("Domain planning instructions must not be empty");
  }
  if (definition.planning.objectives.length === 0) {
    throw new Error("Domain planning objectives must not be empty");
  }
  if (definition.planning.objectives.some((objective) => objective.trim().length === 0)) {
    throw new Error("Domain planning objectives must not contain empty values");
  }
  if (typeof definition.planning.validatePlan !== "function") {
    throw new Error("Domain planning validatePlan is required");
  }
  if (definition.replanning.instructions.trim().length === 0) {
    throw new Error("Domain replanning instructions must not be empty");
  }
  executionModeSchema.parse(definition.replanning.defaultMode);
  if (typeof definition.replanning.reconcileWorldState !== "function") {
    throw new Error("Domain replanning reconcileWorldState is required");
  }
  if (definition.realtime.instructions.trim().length === 0) {
    throw new Error("Domain realtime instructions must not be empty");
  }
  if (definition.realtime.defaultLocale.trim().length === 0) {
    throw new Error("Domain realtime defaultLocale must not be empty");
  }
  for (const schema of Object.values(definition.schemas)) {
    if (!(schema instanceof z.ZodType)) throw new Error("Domain schemas must be Zod schemas");
  }
  for (const capability of definition.capabilities) {
    capabilityDefinitionSchema(capability.inputSchema, capability.outputSchema).parse(capability);
  }
  executionGoalSchema.shape.completionPolicy.parse(definition.completionPolicy);
  return definition;
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
