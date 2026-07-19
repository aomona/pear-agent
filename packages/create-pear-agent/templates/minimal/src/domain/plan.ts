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
): ExecutionPlan<{ task: string }> {
  return {
    id: `starter-${crypto.randomUUID()}`,
    version: 1,
    title: input.title,
    goal,
    metadata: { domainId: "starter", domainVersion: 1 },
    steps: input.tasks.map((task, index) => ({
      id: `task-${index + 1}`,
      label: task.title,
      summary: `Step ${index + 1} of ${input.tasks.length}`,
      instructions: task.description,
      executor: { type: "human" },
      after: index === 0 ? [] : [`task-${index}`],
      requirements: [],
      estimatedDurationSeconds: task.estimatedDurationSeconds,
      timers: [],
      sourceRefs: task.sourceRefs,
      domainData: { task: task.title },
    })),
  };
}
