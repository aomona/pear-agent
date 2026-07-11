import { z } from "zod";

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
  updatedAt: z.date(),
});

export type WorldState = z.infer<typeof worldStateSchema>;
