import { buildPlanPresentation } from "@pear-agent/core";
import { useExecutionSession, useRuntimeSnapshot } from "@pear-agent/react";
import { useMemo } from "react";
import { toast } from "sonner";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Separator } from "./ui/separator";

function statusVariant(
  status: string,
): "default" | "secondary" | "success" | "warning" | "destructive" | "outline" {
  switch (status) {
    case "active":
      return "default";
    case "completed":
      return "success";
    case "failed":
      return "destructive";
    case "ready":
      return "warning";
    case "blocked":
      return "secondary";
    default:
      return "outline";
  }
}

type PlanStepsPanelProps = {
  sessionId: string | null;
};

export function PlanStepsPanel({ sessionId }: PlanStepsPanelProps) {
  const { snapshot, status, error, refetch } = useRuntimeSnapshot(sessionId);
  const session = useExecutionSession(sessionId);

  const plan = snapshot?.plan;
  const stepStates = snapshot?.stepStates ?? {};

  const presentation = useMemo(
    () => (plan ? buildPlanPresentation(plan, stepStates) : null),
    [plan, stepStates],
  );

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      toast.success(label);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Plan & Steps</CardTitle>
        <CardDescription>
          {presentation ? (
            <>
              {presentation.title} · critical path ~{presentation.totalDurationSeconds}s · lanes{" "}
              {presentation.lanes.length}
            </>
          ) : (
            "Session を作成すると Plan が表示されます。"
          )}{" "}
          Snapshot: {status}
          {snapshot?.session.status ? ` · session ${snapshot.session.status}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
        {!presentation ? (
          <p className="text-sm text-muted-foreground">Plan 待ち…</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>ready: {presentation.readyIds.join(", ") || "—"}</span>
              <span>·</span>
              <span>critical: {presentation.criticalPath.join(" → ") || "—"}</span>
            </div>
            <ul className="space-y-3">
              {presentation.nodes.map((node) => {
                const st = node.status ?? stepStates[node.id]?.status ?? "unknown";
                const step = plan?.steps.find((s) => s.id === node.id);
                return (
                  <li key={node.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{node.label}</span>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {node.id}
                          </Badge>
                          <Badge variant={statusVariant(st)}>{st}</Badge>
                          <span className="text-xs text-muted-foreground">
                            ~{node.estimatedDurationSeconds}s · depth {node.depth}
                          </span>
                        </div>
                        {node.instructions ? (
                          <p className="text-sm text-muted-foreground">{node.instructions}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!sessionId}
                          onClick={() =>
                            void run(`Started ${node.id}`, () =>
                              session.startStep({ stepId: node.id }),
                            )
                          }
                        >
                          Start
                        </Button>
                        <Button
                          size="sm"
                          disabled={!sessionId}
                          onClick={() =>
                            void run(`Completed ${node.id}`, () =>
                              session.completeStep({ stepId: node.id }),
                            )
                          }
                        >
                          Complete
                        </Button>
                      </div>
                    </div>
                    {step && step.timers.length > 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Timers:{" "}
                        {step.timers
                          .map((t) => `${t.label ?? t.id} (${t.durationSeconds}s)`)
                          .join(", ")}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <Separator />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!sessionId}
            onClick={() =>
              void run("Charge timer started", () =>
                session.startTimer({ timerId: "charge-wait", durationSeconds: 300 }),
              )
            }
          >
            Start charge-wait timer
          </Button>
          <Button size="sm" variant="ghost" disabled={!sessionId} onClick={() => void refetch()}>
            Refresh snapshot
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
