import { z } from "zod";

import { dateSchema } from "./date.js";

export const executionSessionStatusSchema = z.enum([
  "not_started",
  "active",
  "paused",
  "completed",
  "cancelled",
]);

export type ExecutionSessionStatus = z.infer<typeof executionSessionStatusSchema>;

export const executionSessionSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
  goalId: z.string().min(1),
  status: executionSessionStatusSchema,
  actorIds: z.array(z.string().min(1)).min(1),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

export type ExecutionSession = z.infer<typeof executionSessionSchema>;
