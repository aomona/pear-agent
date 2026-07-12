import { useExecutionSession, useRuntimeSnapshot } from "@pear-agent/react";
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
          pack と charge は並行実行できます。Snapshot 同期: {status}
          {snapshot?.session.status ? ` · session ${snapshot.session.status}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
        {!plan ? (
          <p className="text-sm text-muted-foreground">
            Session を作成すると Plan が表示されます。
          </p>
        ) : (
          <ul className="space-y-3">
            {plan.steps.map((step) => {
              const st = stepStates[step.id]?.status ?? "unknown";
              return (
                <li key={step.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{step.id}</span>
                      <Badge variant={statusVariant(st)}>{st}</Badge>
                      <span className="text-xs text-muted-foreground">
                        ~{step.estimatedDurationSeconds}s
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!sessionId}
                        onClick={() =>
                          void run(`Started ${step.id}`, () =>
                            session.startStep({ stepId: step.id }),
                          )
                        }
                      >
                        Start
                      </Button>
                      <Button
                        size="sm"
                        disabled={!sessionId}
                        onClick={() =>
                          void run(`Completed ${step.id}`, () =>
                            session.completeStep({ stepId: step.id }),
                          )
                        }
                      >
                        Complete
                      </Button>
                    </div>
                  </div>
                  {step.timers.length > 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Timers: {JSON.stringify(step.timers)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
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
