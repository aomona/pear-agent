import { computeCriticalPathIds, topologicalOrder, validatePlanGraph } from "./plan-graph.js";
import {
  effectiveResourceRequirements,
  type ExecutionPlan,
  type ExecutionStep,
  type ResourceCapacity,
  type StepTimeline,
} from "./plan.js";

export type ScheduleConflict = {
  stepId: string;
  resourceId: string;
  atOffsetSeconds: number;
  needed: number;
  available: number;
};

export type SchedulePlanOptions = {
  /** Concurrent capacity per resource. Missing ids are treated as unlimited. */
  capacities?: readonly ResourceCapacity[];
  /**
   * When true (default), delay steps until capacity is free.
   * When false, schedule ASAP by deps only and report conflicts.
   */
  resolveCapacity?: boolean;
};

export type SchedulePlanResult<TStepData = unknown> = {
  plan: ExecutionPlan<TStepData>;
  conflicts: ScheduleConflict[];
  criticalPath: string[];
  /** Makespan of the leveled schedule (max step end), not dep-only critical path. */
  totalDurationSeconds: number;
};

type Interval = { start: number; end: number; quantity: number };

/**
 * CE-05: pure greedy scheduler.
 * - Earliest start = max(dependency ends)
 * - Optionally level resources by delaying starts until capacity fits
 * - Writes CE-04 timeline onto each step
 */
export function schedulePlan<TStepData>(
  plan: ExecutionPlan<TStepData>,
  options: SchedulePlanOptions = {},
): SchedulePlanResult<TStepData> {
  const resolveCapacity = options.resolveCapacity !== false;
  const capacityById = new Map(
    (options.capacities ?? []).map((c) => [
      c.id,
      // exclusive ⇒ capacity 1 regardless of numeric capacity field
      c.mode === "exclusive" ? 1 : c.capacity,
    ]),
  );

  const graph = validatePlanGraph(plan.steps);
  if (!graph.valid) {
    throw new Error(`Cannot schedule plan: ${graph.reason}`);
  }

  const order = topologicalOrder(plan.steps);
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const timelines = new Map<string, StepTimeline>();
  const usage = new Map<string, Interval[]>();
  const conflicts: ScheduleConflict[] = [];

  for (const stepId of order) {
    const step = byId.get(stepId)!;
    const depEnd =
      step.after.length === 0
        ? 0
        : Math.max(...step.after.map((depId) => timelines.get(depId)?.endOffsetSeconds ?? 0));

    let start = depEnd;
    const duration = step.estimatedDurationSeconds;
    const reqs = effectiveResourceRequirements(step);

    if (resolveCapacity && reqs.length > 0) {
      assertFeasibleRequirements(step.id, reqs, capacityById);
      start = findEarliestStart(start, duration, reqs, capacityById, usage, step.id);
    } else if (!resolveCapacity) {
      for (const req of reqs) {
        const cap = capacityById.get(req.resourceId);
        if (cap === undefined) continue;
        if (req.quantity > cap) {
          conflicts.push({
            stepId,
            resourceId: req.resourceId,
            atOffsetSeconds: start,
            needed: req.quantity,
            available: cap,
          });
          continue;
        }
        const peak = peakUsage(usage.get(req.resourceId) ?? [], start, start + duration);
        if (peak + req.quantity > cap) {
          conflicts.push({
            stepId,
            resourceId: req.resourceId,
            atOffsetSeconds: start,
            needed: req.quantity,
            available: Math.max(0, cap - peak),
          });
        }
      }
    }

    const timeline: StepTimeline = {
      startOffsetSeconds: start,
      endOffsetSeconds: start + duration,
    };
    timelines.set(stepId, timeline);

    for (const req of reqs) {
      const list = usage.get(req.resourceId) ?? [];
      list.push({ start, end: start + duration, quantity: req.quantity });
      usage.set(req.resourceId, list);
    }
  }

  const scheduledSteps: ExecutionStep<TStepData>[] = plan.steps.map((step) => {
    const timeline = timelines.get(step.id)!;
    return { ...step, timeline };
  });

  const scheduledPlan: ExecutionPlan<TStepData> = {
    ...plan,
    steps: scheduledSteps,
  };

  let makespan = 0;
  for (const timeline of timelines.values()) {
    if (timeline.endOffsetSeconds > makespan) makespan = timeline.endOffsetSeconds;
  }

  return {
    plan: scheduledPlan,
    conflicts,
    criticalPath: computeCriticalPathIds(scheduledSteps),
    totalDurationSeconds: makespan,
  };
}

/** A single step that needs more than configured capacity can never be scheduled. */
function assertFeasibleRequirements(
  stepId: string,
  reqs: { resourceId: string; quantity: number }[],
  capacityById: Map<string, number>,
): void {
  for (const req of reqs) {
    const cap = capacityById.get(req.resourceId);
    if (cap === undefined) continue;
    if (req.quantity > cap) {
      throw new Error(
        `Cannot schedule step ${stepId}: requires ${req.quantity} of ${req.resourceId} but capacity is ${cap}`,
      );
    }
  }
}

function peakUsage(intervals: readonly Interval[], start: number, end: number): number {
  const events: { t: number; delta: number }[] = [];
  for (const iv of intervals) {
    if (iv.end <= start || iv.start >= end) continue;
    events.push({ t: Math.max(iv.start, start), delta: iv.quantity });
    events.push({ t: Math.min(iv.end, end), delta: -iv.quantity });
  }
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let cur = 0;
  let peak = 0;
  for (const e of events) {
    cur += e.delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}

function findEarliestStart(
  earliest: number,
  duration: number,
  reqs: { resourceId: string; quantity: number }[],
  capacityById: Map<string, number>,
  usage: Map<string, Interval[]>,
  stepId: string,
): number {
  let start = earliest;
  for (let attempt = 0; attempt < 10_000; attempt++) {
    let delayTo = start;
    let ok = true;
    for (const req of reqs) {
      const cap = capacityById.get(req.resourceId);
      if (cap === undefined) continue;
      const intervals = usage.get(req.resourceId) ?? [];
      const peak = peakUsage(intervals, start, start + duration);
      if (peak + req.quantity > cap) {
        ok = false;
        let next = start + duration;
        for (const iv of intervals) {
          if (iv.end > start && iv.end < next) next = iv.end;
        }
        if (next <= start) next = start + 1;
        delayTo = Math.max(delayTo, next);
      }
    }
    if (ok) return start;
    start = delayTo;
  }
  throw new Error(
    `Cannot schedule step ${stepId}: resource leveling did not converge after 10,000 attempts`,
  );
}
