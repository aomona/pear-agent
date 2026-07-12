import {
  buildOutingWorldState,
  type OutingNormalizedInput,
} from "@pear-agent/outing-domain-example";
import { useExecutionSession, usePearContext, type PlanArtifactDetail } from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type PlanDraftPanelProps = {
  planId: string;
  artifact: PlanArtifactDetail;
  onArtifactChange: (artifact: PlanArtifactDetail) => void;
  onBackToInput: () => void;
  onSessionStarted: (sessionId: string) => void;
};

export function PlanDraftPanel({
  planId,
  artifact,
  onArtifactChange,
  onBackToInput,
  onSessionStarted,
}: PlanDraftPanelProps) {
  const { client } = usePearContext();
  const session = useExecutionSession();
  const [improveRequest, setImproveRequest] = useState("充電待ちを短くして");
  const [busy, setBusy] = useState(false);

  const steps = artifact.currentPlan.steps;
  const hasSteps = steps.length > 0;
  const canStart = artifact.status === "ready" && hasSteps;

  async function run(label: string, fn: () => Promise<PlanArtifactDetail>) {
    setBusy(true);
    try {
      const next = await fn();
      onArtifactChange(next);
      toast.success(label);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    setBusy(true);
    try {
      const normalized = artifact.normalizedInput as OutingNormalizedInput | undefined;
      if (!normalized) {
        throw new Error("normalizedInput missing; go back and normalize first");
      }
      const worldState = buildOutingWorldState(normalized);
      const created = await session.create({
        domainId: artifact.domainId,
        actorIds: ["demo-user"],
        planArtifactId: planId,
        worldState,
      });
      await session.startSession();
      onSessionStarted(created.sessionId);
      toast.success("Session started from saved plan");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>3. Execution plan</CardTitle>
            <CardDescription>生成・改善して ready にしたあと実行します。</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={artifact.status === "ready" ? "success" : "secondary"}>
              {artifact.status}
            </Badge>
            <Badge variant="outline">v{artifact.version}</Badge>
            <Button variant="outline" size="sm" onClick={onBackToInput}>
              Edit input
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || artifact.normalizedInput === undefined}
            onClick={() => void run("Plan generated", () => client.generatePlanArtifact(planId))}
          >
            Generate plan
          </Button>
          <Button
            variant="outline"
            disabled={busy || !hasSteps}
            onClick={() =>
              void run("Marked ready", () => client.updatePlan(planId, { status: "ready" }))
            }
          >
            Mark ready
          </Button>
          {artifact.status === "ready" ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run("Back to draft", () => client.updatePlan(planId, { status: "draft" }))
              }
            >
              Reopen draft
            </Button>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="improve">Improve (Gemini)</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="improve"
              value={improveRequest}
              onChange={(e) => setImproveRequest(e.target.value)}
              placeholder="Make packing instructions clearer"
              className="min-w-[220px] flex-1"
            />
            <Button
              variant="secondary"
              disabled={busy || !hasSteps || !improveRequest.trim()}
              onClick={() =>
                void run("Plan improved", () =>
                  client.improvePlan(planId, { request: improveRequest.trim() }),
                )
              }
            >
              Improve
            </Button>
          </div>
        </div>

        {!hasSteps ? (
          <p className="text-sm text-muted-foreground">
            まだ steps がありません。Generate plan を押してください。
          </p>
        ) : (
          <ul className="space-y-2">
            {steps.map((step) => (
              <li key={step.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="font-medium">
                  {step.label ?? step.id}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    ({step.estimatedDurationSeconds}s)
                  </span>
                </div>
                {step.summary ? <p className="text-muted-foreground">{step.summary}</p> : null}
                {step.instructions ? <p className="mt-1 text-xs">{step.instructions}</p> : null}
              </li>
            ))}
          </ul>
        )}

        <Button disabled={busy || !canStart} onClick={() => void handleStart()}>
          {busy ? "Starting…" : "Start execution from this plan"}
        </Button>
        {!canStart && hasSteps ? (
          <p className="text-xs text-muted-foreground">Mark ready before starting a session.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
