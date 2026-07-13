import { buildPlanPresentation, type ExecutionPlan } from "@pear-agent/core";
import { useMemo } from "react";

import { Badge } from "./ui/badge";

type PlanLanesProps = {
  plan: ExecutionPlan;
};

/** Visual lanes by topological depth (parallelizable cohorts). */
export function PlanLanes({ plan }: PlanLanesProps) {
  const presentation = useMemo(() => buildPlanPresentation(plan), [plan]);
  const critical = new Set(presentation.criticalPath);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{presentation.title}</span>
        <span>·</span>
        <span>critical ~{presentation.totalDurationSeconds}s</span>
        <span>·</span>
        <span>{presentation.lanes.length} lanes</span>
      </div>
      <div className="grid gap-2">
        {presentation.lanes.map((lane, depth) => (
          <div key={depth} className="rounded-md border bg-muted/20 p-2">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Lane {depth}
              {depth === 0 ? " · start together" : " · after previous"}
            </p>
            <div className="flex flex-wrap gap-2">
              {lane.map((id) => {
                const node = presentation.nodes.find((n) => n.id === id);
                if (!node) return null;
                return (
                  <div
                    key={id}
                    className="min-w-[140px] flex-1 rounded-md border bg-background px-2 py-1.5 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="font-medium">{node.label}</span>
                      {critical.has(id) ? (
                        <Badge variant="warning" className="text-[10px]">
                          critical
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      ~{node.estimatedDurationSeconds}s
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {presentation.criticalPath.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Critical path: {presentation.criticalPath.join(" → ")}
        </p>
      ) : null}
    </div>
  );
}
