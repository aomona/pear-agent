/** Valid Core wire fixtures for client/hook tests (ISO dates as on the wire). */

export const sampleGoal = {
  id: "goal-1",
  description: "Leave ready",
  successCriteria: [
    {
      id: "c1",
      description: "packed",
      evaluator: { type: "human_confirmation" as const },
    },
  ],
  completionPolicy: "automatic" as const,
};

export const samplePlan = {
  id: "plan-1",
  version: 1,
  goal: sampleGoal,
  steps: [
    {
      id: "pack",
      executor: { type: "human" as const },
      after: [] as string[],
      requirements: [] as string[],
      estimatedDurationSeconds: 60,
      timers: [] as unknown[],
      domainData: {},
    },
  ],
};

export const sampleSession = {
  id: "s1",
  status: "active" as const,
  planId: "plan-1",
  planVersion: 1,
  goalId: "goal-1",
  actorIds: ["traveler"],
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:01:00.000Z",
};

export const sampleWorldState = {
  facts: {},
  resources: [] as { id: string; state: unknown }[],
  observations: [] as { type: string; data: unknown }[],
  activeConstraints: [] as string[],
  updatedAt: "2026-07-11T00:01:00.000Z",
};

export const sampleSnapshot = {
  plan: samplePlan,
  session: sampleSession,
  worldState: sampleWorldState,
  stepStates: { pack: { status: "ready" as const } },
  activeTimers: [] as unknown[],
  recentEvents: [] as unknown[],
  readyStepIds: ["pack"],
  activeStepIds: [] as string[],
  blockedStepIds: [] as string[],
  generatedAt: "2026-07-11T00:01:00.000Z",
};

export function sampleMaterializedState(overrides?: {
  stepStatus?: "ready" | "completed" | "active";
  appliedIdempotencyKeys?: string[];
}) {
  return {
    session: sampleSession,
    plan: samplePlan,
    worldState: sampleWorldState,
    stepStates: { pack: { status: overrides?.stepStatus ?? "ready" } },
    timers: {},
    criterionEvaluations: {},
    criterionEvaluationHistory: [] as unknown[],
    appliedEventIds: [] as string[],
    appliedIdempotencyKeys: overrides?.appliedIdempotencyKeys ?? ([] as string[]),
  };
}
