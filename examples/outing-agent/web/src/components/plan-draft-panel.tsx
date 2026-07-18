import {
  buildOutingWorldState,
  type OutingNormalizedInput,
} from "@pear-agent/outing-domain-example";
import {
  useExecutionSession,
  usePearContext,
  type PlanArtifactDetail,
  type PlanEditProposal,
} from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import { generateSuccessMessage, orderBadgeLabel, orderMeta } from "../lib/order-meta";
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
  const [proposal, setProposal] = useState<PlanEditProposal | null>(null);

  const steps = artifact.currentPlan.steps;
  const hasSteps = steps.length > 0;
  const canStart = hasSteps;
  const normalized = artifact.normalizedInput as OutingNormalizedInput | undefined;
  const orderLabel = orderBadgeLabel(artifact.currentPlan);

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

  async function proposeImprovement(request: string) {
    setBusy(true);
    try {
      setProposal(await client.proposePlanEdit(planId, request));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function applyProposal() {
    if (!proposal) return;
    await run("改善しました", async () => {
      const result = await client.confirmPlanEdit(planId, proposal.id);
      setProposal(null);
      return result.artifact;
    });
  }

  async function handleRegenerate() {
    setBusy(true);
    try {
      const next = await client.generatePlanArtifact(planId);
      onArtifactChange(next);
      toast.success(generateSuccessMessage(next.currentPlan));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** Main path: ready (if needed) + create session + start. */
  async function handleStart() {
    setBusy(true);
    try {
      if (!normalized) {
        throw new Error("入力がありません。入力へ戻って「計画をつくる」を押してください");
      }
      if (!hasSteps) {
        throw new Error("ステップがありません。入力から計画をつくってください");
      }

      let current = artifact;
      if (current.status !== "ready") {
        current = await client.updatePlan(planId, { status: "ready" });
        onArtifactChange(current);
      }

      const worldState = buildOutingWorldState(normalized);
      const created = await session.create({
        domainId: current.domainId,
        actorIds: ["demo-user"],
        planArtifactId: planId,
        worldState,
      });
      await session.startSession();
      onSessionStarted(created.sessionId);
      toast.success("実行を開始しました");
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
            <CardTitle>3. 実行計画</CardTitle>
            <CardDescription>
              レーンで順序を確認 →「実行を開始」。必要ならかんたん改善や再生成。
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={artifact.status === "ready" ? "success" : "secondary"}>
              {artifact.status === "ready" ? "実行可" : artifact.status}
            </Badge>
            <Badge variant="outline">v{artifact.version}</Badge>
            {orderLabel ? (
              <Badge variant={orderMeta(artifact.currentPlan).refined ? "success" : "outline"}>
                {orderLabel}
              </Badge>
            ) : null}
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
          <p className="text-sm text-muted-foreground">入力がありません。入力へ戻ってください。</p>
        )}

        {!hasSteps ? (
          <p className="text-sm text-muted-foreground">
            まだ steps がありません。入力で「計画をつくる」を押してください。
          </p>
        ) : (
          <PlanLanes plan={artifact.currentPlan} />
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Button size="lg" disabled={busy || !canStart} onClick={() => void handleStart()}>
            {busy ? "開始中…" : "実行を開始"}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !normalized}
            onClick={() => void handleRegenerate()}
          >
            計画を再生成
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          未 ready でも開始時に自動で実行可能にします。再生成すると順序を Gemini が付け直します。
        </p>

        <div className="space-y-2 rounded-lg border p-3">
          <Label className="text-muted-foreground">かんたん改善（任意）</Label>
          <div className="flex flex-wrap gap-2">
            {IMPROVE_CHIPS.map((chip) => (
              <Button
                key={chip.label}
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || !hasSteps}
                onClick={() => void proposeImprovement(chip.request)}
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
              onClick={() => void proposeImprovement(improveRequest.trim())}
            >
              変更案を作成
            </Button>
          </div>
          {proposal ? (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                追加 {proposal.diff.addedStepIds.length}・変更 {proposal.diff.updatedStepIds.length}
                ・削除 {proposal.diff.removedStepIds.length}・所要時間差{" "}
                {proposal.diff.durationDeltaSeconds >= 0 ? "+" : ""}
                {proposal.diff.durationDeltaSeconds}秒
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void applyProposal()}>
                  この変更案を適用
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setProposal(null)}
                >
                  破棄
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
