import {
  computeCriticalPathIds,
  effectiveResourceRequirements,
  estimateCriticalPathDurationSeconds,
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
    (options.capacities ?? []).map((c) => [c.id, c.mode === "exclusive" ? 1 : c.capacity]),
  );

  const graph = validateAcyclic(plan.steps);
  if (!graph.ok) {
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
      start = findEarliestStart(start, duration, reqs, capacityById, usage);
    } else if (!resolveCapacity) {
      for (const req of reqs) {
        const cap = capacityById.get(req.resourceId);
        if (cap === undefined) continue;
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

  return {
    plan: scheduledPlan,
    conflicts,
    criticalPath: computeCriticalPathIds(scheduledSteps),
    totalDurationSeconds: estimateCriticalPathDurationSeconds(scheduledSteps),
  };
}

function validateAcyclic(
  steps: readonly ExecutionStep[],
): { ok: true } | { ok: false; reason: string } {
  const ids = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    for (const dep of step.after) {
      if (!ids.has(dep)) return { ok: false, reason: `missing dependency ${dep}` };
    }
  }
  // Reuse cycle detection via simple DFS
  const deps = new Map(steps.map((s) => [s.id, s.after]));
  const visited = new Set<string>();
  const stack = new Set<string>();
  const visit = (id: string): boolean => {
    if (stack.has(id)) return false;
    if (visited.has(id)) return true;
    visited.add(id);
    stack.add(id);
    for (const d of deps.get(id) ?? []) {
      if (!visit(d)) return false;
    }
    stack.delete(id);
    return true;
  };
  for (const step of steps) {
    if (!visit(step.id)) return { ok: false, reason: "cycle" };
  }
  return { ok: true };
}

function topologicalOrder(steps: readonly ExecutionStep[]): string[] {
  const indegree = new Map(steps.map((s) => [s.id, 0]));
  const children = new Map<string, string[]>();
  for (const step of steps) {
    for (const dep of step.after) {
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      const list = children.get(dep) ?? [];
      list.push(step.id);
      children.set(dep, list);
    }
  }
  const queue = steps.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (order.length !== steps.length) {
    throw new Error("Cannot schedule plan: cycle");
  }
  return order;
}

function peakUsage(intervals: readonly Interval[], start: number, end: number): number {
  // Sweep events inside [start, end)
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
): number {
  let start = earliest;
  // Bound search: push by residual peaks until fit (simple iterative delay).
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
        // Jump to next interval end that reduces usage after start
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
  return start;
}
