import type { ExecutionGoal, ExecutionPlan } from "@pear-agent/core";

import type { StarterNormalizedInput } from "./domain.js";

export function buildStarterGoal(title: string): ExecutionGoal {
  return {
    id: "finish-work",
    description: `Complete: ${title}`,
    successCriteria: [
      {
        id: "all-tasks-complete",
        description: "Every planned task is complete",
        evaluator: { type: "human_confirmation" },
      },
    ],
    completionPolicy: "automatic",
  };
}

export function buildStarterPlan(
  goal: ExecutionGoal,
  input: StarterNormalizedInput,
): ExecutionPlan<{ taskId: string }> {
  return {
    id: `starter-${crypto.randomUUID()}`,
    version: 1,
    title: input.title,
    goal,
    metadata: { domainId: "starter", domainVersion: 1 },
    steps: input.tasks.map((task, index) => ({
      id: task.id,
      label: task.title,
      summary: `Step ${index + 1} of ${input.tasks.length}`,
      instructions: task.title,
      executor: { type: "human" },
      after: index === 0 ? [] : [input.tasks[index - 1]!.id],
      requirements: [],
      estimatedDurationSeconds: task.estimatedDurationSeconds,
      timers: [],
      domainData: { taskId: task.id },
    })),
  };
}
