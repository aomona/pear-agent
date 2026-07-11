import { z } from "zod";

export const stepStatusSchema = z.enum([
  "blocked",
  "ready",
  "active",
  "paused",
  "completed",
  "failed",
  "skipped",
]);

export type StepStatus = z.infer<typeof stepStatusSchema>;

export const stepStateSchema = z.object({ status: stepStatusSchema });

export type StepState = z.infer<typeof stepStateSchema>;

export const stepStatesSchema = z.record(z.string(), stepStateSchema);

export type StepStates = z.infer<typeof stepStatesSchema>;

export type StepDependency = {
  readonly id: string;
  readonly after: readonly string[];
};

const TERMINAL_STATUSES = new Set<StepStatus>(["completed", "skipped"]);

export function deriveStepStatuses(
  steps: readonly StepDependency[],
  currentStates: Readonly<Record<string, StepState>>,
): Record<string, StepState> {
  const derivedStates: Record<string, StepState> = {};

  for (const step of steps) {
    const currentState = currentStates[step.id];
    if (currentState && !["blocked", "ready"].includes(currentState.status)) {
      derivedStates[step.id] = currentState;
      continue;
    }

    const dependenciesSatisfied = step.after.every((dependencyId) => {
      const dependencyStatus = currentStates[dependencyId]?.status;
      return dependencyStatus !== undefined && TERMINAL_STATUSES.has(dependencyStatus);
    });
    derivedStates[step.id] = { status: dependenciesSatisfied ? "ready" : "blocked" };
  }

  return derivedStates;
}

const ALLOWED_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  blocked: ["ready", "skipped"],
  ready: ["active", "skipped"],
  active: ["paused", "completed", "failed", "skipped"],
  paused: ["active", "completed", "failed", "skipped"],
  completed: [],
  failed: ["ready", "skipped"],
  skipped: [],
};

export function transitionStep(state: StepState, nextStatus: StepStatus): StepState {
  if (!ALLOWED_TRANSITIONS[state.status].includes(nextStatus)) {
    throw new Error(`Invalid step transition: ${state.status} -> ${nextStatus}`);
  }

  return { status: nextStatus };
}
