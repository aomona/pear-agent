import { z } from "zod";

import { dateSchema } from "./date.js";

export const jsonValueSchema = z.json();

export type JsonValue = z.infer<typeof jsonValueSchema>;

export const worldStateResourceSchema = z.object({
  id: z.string().min(1),
  state: jsonValueSchema,
});

export type WorldStateResource = z.infer<typeof worldStateResourceSchema>;

export const worldStateObservationSchema = z.object({
  type: z.string().min(1),
  data: jsonValueSchema,
});

export type WorldStateObservation = z.infer<typeof worldStateObservationSchema>;

export const worldStateSchema = z.object({
  facts: z.record(z.string(), jsonValueSchema),
  resources: z.array(worldStateResourceSchema),
  observations: z.array(worldStateObservationSchema),
  activeConstraints: z.array(z.string().min(1)),
  updatedAt: dateSchema,
});

export type WorldState = z.infer<typeof worldStateSchema>;

export type CreateWorldStateInput = {
  facts?: Record<string, JsonValue>;
  resources?: WorldStateResource[];
  observations?: WorldStateObservation[];
  activeConstraints?: string[];
  updatedAt: Date;
};

/**
 * Builds a runtime WorldState envelope. Domain-specific state belongs in
 * `facts`; Domain schemas describe that facts object, not this envelope.
 */
export function createWorldState(input: CreateWorldStateInput): WorldState {
  return worldStateSchema.parse({
    facts: input.facts ?? {},
    resources: input.resources ?? [],
    observations: input.observations ?? [],
    activeConstraints: input.activeConstraints ?? [],
    updatedAt: input.updatedAt,
  });
}

/**
 * Validates domain facts with the Domain `schemas.worldState` schema and wraps
 * them in the Core WorldState envelope.
 */
export function createWorldStateFromDomainFacts<TFactsSchema extends z.ZodType>(
  domainWorldStateSchema: TFactsSchema,
  facts: z.input<TFactsSchema>,
  options: Omit<CreateWorldStateInput, "facts">,
): WorldState {
  const parsedFacts = domainWorldStateSchema.parse(facts);
  const jsonFacts = jsonValueSchema.parse(parsedFacts);
  if (typeof jsonFacts !== "object" || jsonFacts === null || Array.isArray(jsonFacts)) {
    throw new Error("Domain worldState facts must be a JSON object");
  }
  return createWorldState({
    ...options,
    facts: jsonFacts as Record<string, JsonValue>,
  });
}

/**
 * Reads and validates Domain facts from a runtime WorldState envelope using
 * the Domain `schemas.worldState` schema.
 */
export function parseDomainWorldStateFacts<TFactsSchema extends z.ZodType>(
  domainWorldStateSchema: TFactsSchema,
  worldState: WorldState,
): z.output<TFactsSchema> {
  return domainWorldStateSchema.parse(worldState.facts);
}
