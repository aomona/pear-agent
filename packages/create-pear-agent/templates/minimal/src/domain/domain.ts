import { defineDomain } from "@pear-agent/core";
import { z } from "zod";

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  estimatedDurationSeconds: z.number().int().positive().default(300),
});

export const starterInputSchema = z.object({
  title: z.string().trim().min(1),
  tasks: z.array(z.string().trim().min(1)).min(1),
});

export const starterNormalizedInputSchema = z.object({
  title: z.string().trim().min(1),
  tasks: z.array(taskSchema).min(1),
});

export type StarterNormalizedInput = z.output<typeof starterNormalizedInputSchema>;

export const starterDomain = defineDomain({
  id: "starter",
  version: 1,
  schemas: {
    input: starterInputSchema,
    normalizedInput: starterNormalizedInputSchema,
    stepData: z.object({ taskId: z.string().min(1) }),
    worldState: z.object({ notes: z.array(z.string()) }),
    events: z.discriminatedUnion("type", [
      z.object({ type: z.literal("constraint_changed"), note: z.string().min(1) }),
    ]),
  },
  normalizeInput: async ({ title, tasks }) => ({
    title: title.trim(),
    tasks: tasks.map((task, index) => ({
      id: `task-${index + 1}`,
      title: task.trim(),
      estimatedDurationSeconds: 300,
    })),
  }),
  planning: {
    instructions: "Turn the normalized task list into a clear sequential execution plan.",
    objectives: ["Make the next action obvious", "Keep the plan easy to edit"],
  },
  replanning: {
    instructions: "Update only the work affected by a changed constraint.",
    defaultMode: "suggest",
  },
  capabilities: [],
  completionPolicy: "automatic",
});
