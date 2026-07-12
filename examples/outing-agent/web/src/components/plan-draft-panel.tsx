import {
  buildOutingWorldState,
  type OutingNormalizedInput,
} from "@pear-agent/outing-domain-example";
import { useExecutionSession, usePearContext, type PlanArtifactDetail } from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import { PlanLanes } from "./plan-lanes";
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

const IMPROVE_CHIPS = [
  { label: "充電を短く", request: "充電ステップの所要時間を短くして" },
  { label: "説明を丁寧に", request: "各ステップの instructions をもう少し丁寧に" },
  { label: "タイトル明確に", request: "plan title を行き先が分かる短文にして" },
] as const;

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
  const normalized = artifact.normalizedInput as OutingNormalizedInput | undefined;

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
            <CardDescription>
              生成時に Gemini が step の順序（after）を整えます。レーンで並列を確認 → ready → 実行。
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={artifact.status === "ready" ? "success" : "secondary"}>
              {artifact.status}
            </Badge>
            <Badge variant="outline">v{artifact.version}</Badge>
            <Button variant="outline" size="sm" onClick={onBackToInput}>
              入力を直す
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {normalized ? (
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">
              {(normalized.originLabel ?? "?") + " → " + (normalized.destinationLabel ?? "?")}
            </Badge>
            <Badge variant="outline">荷物 {normalized.belongings.length}</Badge>
            <Badge variant="outline">タスク {normalized.tasks.length}</Badge>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            normalizedInput がありません。入力へ戻ってください。
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || artifact.normalizedInput === undefined}
            onClick={() =>
              void run("計画を生成（順序は Gemini が調整）", () =>
                client.generatePlanArtifact(planId),
              )
            }
          >
            計画を生成
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            ステップ本体は Domain が決め、依存関係（after）だけ LLM
            が差し替えます。キー無し時は全部並列。
          </p>
          <Button
            variant="outline"
            disabled={busy || !hasSteps}
            onClick={() =>
              void run("実行可能にしました", () => client.updatePlan(planId, { status: "ready" }))
            }
          >
            実行可能にする
          </Button>
          {artifact.status === "ready" ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run("下書きに戻しました", () => client.updatePlan(planId, { status: "draft" }))
              }
            >
              下書きに戻す
            </Button>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label>かんたん改善</Label>
          <div className="flex flex-wrap gap-2">
            {IMPROVE_CHIPS.map((chip) => (
              <Button
                key={chip.label}
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || !hasSteps}
                onClick={() =>
                  void run(chip.label, () => client.improvePlan(planId, { request: chip.request }))
                }
              >
                {chip.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              value={improveRequest}
              onChange={(e) => setImproveRequest(e.target.value)}
              placeholder="自由文で改善指示"
              className="min-w-[220px] flex-1"
            />
            <Button
              variant="outline"
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
            まだ steps がありません。「計画を生成」を押してください。
          </p>
        ) : (
          <PlanLanes plan={artifact.currentPlan} />
        )}

        <Button disabled={busy || !canStart} onClick={() => void handleStart()}>
          {busy ? "Starting…" : "この計画で実行を開始"}
        </Button>
        {!canStart && hasSteps ? (
          <p className="text-xs text-muted-foreground">
            実行前に「実行可能にする」を押してください。
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
