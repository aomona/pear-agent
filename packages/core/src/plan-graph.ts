/**
 * Plan DAG utilities (single source of truth for cycle checks, topo order, critical path).
 */

export type PlanGraphNode = {
  id: string;
  after: readonly string[];
};

export type PlanGraphValidation =
  | { valid: true }
  | { valid: false; reason: "duplicate_id" | "missing_dependency" | "cycle" };

export type TimedPlanNode = PlanGraphNode & {
  estimatedDurationSeconds: number;
};

export function validatePlanGraph(nodes: readonly PlanGraphNode[]): PlanGraphValidation {
  const ids = new Set<string>();
  for (const { id } of nodes) {
    if (ids.has(id)) return { valid: false, reason: "duplicate_id" };
    ids.add(id);
  }

  for (const { after } of nodes) {
    if (after.some((dependencyId) => !ids.has(dependencyId))) {
      return { valid: false, reason: "missing_dependency" };
    }
  }

  const dependencies = new Map(nodes.map(({ id, after }) => [id, after]));
  const visited = new Set<string>();

  // Iterative DFS: avoids stack overflow on deep plans.
  for (const { id: rootId } of nodes) {
    if (visited.has(rootId)) continue;

    const stack: { id: string; enter: boolean }[] = [{ id: rootId, enter: true }];
    const onPath = new Set<string>();

    while (stack.length > 0) {
      const frame = stack.pop()!;
      const { id } = frame;

      if (!frame.enter) {
        onPath.delete(id);
        continue;
      }

      if (visited.has(id)) continue;

      visited.add(id);
      onPath.add(id);
      stack.push({ id, enter: false });

      for (const dependencyId of dependencies.get(id) ?? []) {
        if (onPath.has(dependencyId)) return { valid: false, reason: "cycle" };
        if (!visited.has(dependencyId)) stack.push({ id: dependencyId, enter: true });
      }
    }
  }

  return { valid: true };
}

/** Kahn topological order; throws if the graph is not a valid DAG. */
export function topologicalOrder(nodes: readonly PlanGraphNode[]): string[] {
  const validation = validatePlanGraph(nodes);
  if (!validation.valid) {
    throw new Error(`Invalid plan graph: ${validation.reason}`);
  }

  const indegree = new Map(nodes.map((s) => [s.id, 0]));
  const children = new Map<string, string[]>();
  for (const step of nodes) {
    for (const dep of step.after) {
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      const list = children.get(dep) ?? [];
      list.push(step.id);
      children.set(dep, list);
    }
  }
  const queue = nodes.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
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
  if (order.length !== nodes.length) {
    throw new Error("Invalid plan graph: cycle");
  }
  return order;
}

/** Topological depth of each step (roots = 0). */
export function topologicalDepths(nodes: readonly PlanGraphNode[]): Map<string, number> {
  const byId = new Map(nodes.map((step) => [step.id, step]));
  const depths = new Map<string, number>();

  const depthOf = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const step = byId.get(id);
    if (!step || step.after.length === 0) {
      depths.set(id, 0);
      return 0;
    }
    const d = 1 + Math.max(...step.after.map((depId) => depthOf(depId)));
    depths.set(id, d);
    return d;
  };

  for (const step of nodes) depthOf(step.id);
  return depths;
}

/** Longest-path duration through the DAG (critical path length in seconds). */
export function estimateCriticalPathDurationSeconds(steps: readonly TimedPlanNode[]): number {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const memo = new Map<string, number>();

  const dfs = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const step = byId.get(id);
    if (!step) return 0;
    const depMax = step.after.length === 0 ? 0 : Math.max(...step.after.map((depId) => dfs(depId)));
    const total = depMax + step.estimatedDurationSeconds;
    memo.set(id, total);
    return total;
  };

  let max = 0;
  for (const step of steps) {
    max = Math.max(max, dfs(step.id));
  }
  return max;
}

/** Step ids on one critical path (prefers max predecessor duration). */
export function computeCriticalPathIds(steps: readonly TimedPlanNode[]): string[] {
  if (steps.length === 0) return [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const best = new Map<string, number>();

  const pathLength = (id: string): number => {
    const cached = best.get(id);
    if (cached !== undefined) return cached;
    const step = byId.get(id);
    if (!step) return 0;
    const depMax =
      step.after.length === 0 ? 0 : Math.max(...step.after.map((depId) => pathLength(depId)));
    const total = depMax + step.estimatedDurationSeconds;
    best.set(id, total);
    return total;
  };

  for (const step of steps) pathLength(step.id);

  let endId = steps[0]!.id;
  let endLen = best.get(endId) ?? 0;
  for (const step of steps) {
    const len = best.get(step.id) ?? 0;
    if (len > endLen) {
      endId = step.id;
      endLen = len;
    }
  }

  const path: string[] = [];
  let current: string | undefined = endId;
  while (current) {
    path.push(current);
    const step = byId.get(current);
    if (!step || step.after.length === 0) break;
    let bestDep = step.after[0]!;
    let bestDepLen = best.get(bestDep) ?? 0;
    for (const depId of step.after) {
      const len = best.get(depId) ?? 0;
      if (len > bestDepLen) {
        bestDep = depId;
        bestDepLen = len;
      }
    }
    current = bestDep;
  }
  path.reverse();
  return path;
}
