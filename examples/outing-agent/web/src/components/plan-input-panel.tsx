import type { PlanArtifactDetail } from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import { OUTING_PRESETS } from "../lib/presets";
import { AddPrepModal } from "./add-prep-modal";
import { InputSummary } from "./input-summary";
import { DepartureFields, PlaceFields } from "./plan-input-fields";
import { PrepListItem } from "./prep-list-item";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { usePlanInputController } from "./use-plan-input-controller";

type PlanInputPanelProps = {
  planId: string;
  artifact: PlanArtifactDetail | null;
  /** Called after normalize + generate succeed. */
  onPlanBuilt: (artifact: PlanArtifactDetail) => void;
  onBack: () => void;
};

export function PlanInputPanel({ planId, artifact, onPlanBuilt, onBack }: PlanInputPanelProps) {
  const [addOpen, setAddOpen] = useState(false);
  const controller = usePlanInputController({ planId, artifact, onPlanBuilt });
  const { form, setForm, buildBusy, placeBusy, inFlight, canBuild } = controller;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>2. 準備内容</CardTitle>
              <CardDescription>
                出発・行き先・持ち物・タスクを入れて「計画をつくる」。リストの自由文は並行で構造化します。
                {artifact?.normalizedInput ? " 保存済みの内容を読み込んでいます。" : ""}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={onBack}>
              一覧へ
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              プリセット（ワンタップで埋める）
            </p>
            <div className="flex flex-wrap gap-2">
              {OUTING_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setForm(preset.apply());
                    toast.success(`${preset.label} を適用しました`);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>

          <InputSummary form={form} />
          <DepartureFields form={form} setForm={setForm} />
          <PlaceFields
            form={form}
            setForm={setForm}
            placeBusy={placeBusy}
            onResolvePlace={(which) => void controller.resolvePlace(which)}
          />

          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">準備リスト</h3>
                <p className="text-xs text-muted-foreground">
                  持ち物・タスクを追加。自由文は即表示 → Gemini 並行
                </p>
              </div>
              <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
                ＋ 追加
              </Button>
            </div>

            {form.items.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                まだ項目がありません。プリセットか ＋追加を使ってください。
              </p>
            ) : (
              <ul className="space-y-2">
                {form.items.map((row, index) => (
                  <PrepListItem
                    key={row.key}
                    row={row}
                    index={index}
                    onRemove={() => controller.removeItem(row.key)}
                    onRetry={() => controller.retryItem(row)}
                    onChange={(patch) => controller.patchItem(row.key, patch)}
                  />
                ))}
              </ul>
            )}
          </section>

          <div className="space-y-2">
            <Button
              className="w-full sm:w-auto"
              disabled={!canBuild}
              onClick={() => void controller.buildPlan()}
            >
              {buildBusy
                ? "計画を作成中…"
                : inFlight
                  ? "項目の構造化を待っています…"
                  : "計画をつくる"}
            </Button>
            <p className="text-xs text-muted-foreground">
              入力を保存し、ステップ生成と順序調整まで一気に行います。
            </p>
          </div>
        </CardContent>
      </Card>

      <AddPrepModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={controller.submitPrepItem}
      />
    </>
  );
}
