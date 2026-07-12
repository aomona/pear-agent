import {
  computeCriticalPathIds,
  estimateCriticalPathDurationSeconds,
  topologicalDepths,
} from "./plan-graph.js";
import type { ExecutionPlan, ExecutionStep } from "./plan.js";
import type { StepStates } from "./step-state.js";

export type PlanPresentationNode = {
  id: string;
  label: string;
  summary?: string;
  instructions?: string;
  estimatedDurationSeconds: number;
  after: string[];
  status?: string;
  depth: number;
  startOffsetSeconds?: number;
  endOffsetSeconds?: number;
};

export type PlanPresentationEdge = {
  from: string;
  to: string;
};

export type PlanPresentation = {
  planId: string;
  planVersion: number;
  title: string;
  nodes: PlanPresentationNode[];
  edges: PlanPresentationEdge[];
  /** Steps grouped by topological depth (parallelizable cohorts). */
  lanes: string[][];
  totalDurationSeconds: number;
  criticalPath: string[];
  readyIds: string[];
  blockedIds: string[];
  activeIds: string[];
};

function stepLabel(step: ExecutionStep): string {
  return step.label ?? step.id;
}

/**
 * CE-06: pure presentation model for Plan UI / Devtools.
 * Prefer scheduled `timeline` on nodes when present; duration-based critical path otherwise.
 */
export function buildPlanPresentation(
  plan: ExecutionPlan,
  stepStates?: StepStates,
): PlanPresentation {
  const depths = topologicalDepths(plan.steps);
  const maxDepth = Math.max(0, ...depths.values());
  const lanes: string[][] = Array.from({ length: maxDepth + 1 }, () => []);

  const nodes: PlanPresentationNode[] = plan.steps.map((step) => {
    const depth = depths.get(step.id) ?? 0;
    lanes[depth]?.push(step.id);
    const status = stepStates?.[step.id]?.status;
    const node: PlanPresentationNode = {
      id: step.id,
      label: stepLabel(step),
      estimatedDurationSeconds: step.estimatedDurationSeconds,
      after: [...step.after],
      depth,
    };
    if (step.summary !== undefined) node.summary = step.summary;
    if (step.instructions !== undefined) node.instructions = step.instructions;
    if (status !== undefined) node.status = status;
    if (step.timeline) {
      node.startOffsetSeconds = step.timeline.startOffsetSeconds;
      node.endOffsetSeconds = step.timeline.endOffsetSeconds;
    }
    return node;
  });

  const edges: PlanPresentationEdge[] = [];
  for (const step of plan.steps) {
    for (const from of step.after) {
      edges.push({ from, to: step.id });
    }
  }

  const readyIds: string[] = [];
  const blockedIds: string[] = [];
  const activeIds: string[] = [];
  if (stepStates) {
    for (const [id, state] of Object.entries(stepStates)) {
      if (state.status === "ready") readyIds.push(id);
      else if (state.status === "blocked") blockedIds.push(id);
      else if (state.status === "active" || state.status === "paused") activeIds.push(id);
    }
  }

  return {
    planId: plan.id,
    planVersion: plan.version,
    title: plan.title ?? plan.goal.description,
    nodes,
    edges,
    lanes,
    totalDurationSeconds: estimateCriticalPathDurationSeconds(plan.steps),
    criticalPath: computeCriticalPathIds(plan.steps),
    readyIds,
    blockedIds,
    activeIds,
  };
}
