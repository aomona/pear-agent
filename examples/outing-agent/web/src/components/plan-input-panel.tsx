import { usePearContext, type PlanArtifactDetail } from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import {
  buildOutingInputFromForm,
  defaultDepartureLocal,
  type BelongingFormRow,
  type OutingFormState,
} from "../lib/build-outing-input";
import { AddBelongingModal } from "./add-belonging-modal";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";

type PlanInputPanelProps = {
  planId: string;
  artifact: PlanArtifactDetail | null;
  onNormalized: (artifact: PlanArtifactDetail) => void;
  onBack: () => void;
};

export function PlanInputPanel({ planId, artifact, onNormalized, onBack }: PlanInputPanelProps) {
  const { client } = usePearContext();
  const [form, setForm] = useState<OutingFormState>({
    departureMode: "structured",
    departureLocal: defaultDepartureLocal(),
    departureFreeText: "tomorrow morning 10:00",
    belongings: [],
  });
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  function handleAddRows(rows: BelongingFormRow[]) {
    setForm((f) => ({ ...f, belongings: [...f.belongings, ...rows] }));
    toast.success(rows.length === 1 ? "アイテムを追加しました" : `${rows.length} 件追加しました`);
  }

  function removeBelonging(key: string) {
    setForm((f) => ({
      ...f,
      belongings: f.belongings.filter((r) => r.key !== key),
    }));
  }

  async function handleNormalize() {
    setBusy(true);
    try {
      const input = buildOutingInputFromForm(form);
      const next = await client.normalizePlanInput(planId, input);
      toast.success("Input normalized and saved on plan");
      onNormalized(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>2. What to prepare</CardTitle>
              <CardDescription>
                出発は単独フィールド。持ち物は「追加」で 1
                件ずつモーダルから入れ、構造化して一覧に出します。
                {artifact?.normalizedInput ? " 保存済み normalizedInput あり。" : ""}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={onBack}>
              Back to list
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Departure */}
          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">出発時刻</h3>
                <p className="text-xs text-muted-foreground">この項目だけの入力欄</p>
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={form.departureMode === "structured" ? "default" : "outline"}
                  onClick={() => setForm((f) => ({ ...f, departureMode: "structured" }))}
                >
                  日時
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.departureMode === "freeText" ? "default" : "outline"}
                  onClick={() => setForm((f) => ({ ...f, departureMode: "freeText" }))}
                >
                  自由文
                </Button>
              </div>
            </div>
            {form.departureMode === "structured" ? (
              <div className="space-y-1.5">
                <Label htmlFor="departure">Departure at</Label>
                <Input
                  id="departure"
                  type="datetime-local"
                  value={form.departureLocal}
                  onChange={(e) => setForm((f) => ({ ...f, departureLocal: e.target.value }))}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="departure-free">出発を自然文で</Label>
                <Input
                  id="departure-free"
                  placeholder="例: 明日の朝10時"
                  value={form.departureFreeText}
                  onChange={(e) => setForm((f) => ({ ...f, departureFreeText: e.target.value }))}
                />
              </div>
            )}
          </section>

          {/* Belongings list + add modal */}
          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">持ち物</h3>
                <p className="text-xs text-muted-foreground">
                  追加 → モーダルで入力 →「構造化して追加」の瞬間だけ構造化
                </p>
              </div>
              <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
                ＋ 追加
              </Button>
            </div>

            {form.belongings.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                まだアイテムがありません。「＋ 追加」から 1 件ずつ入れてください。
              </p>
            ) : (
              <ul className="space-y-2">
                {form.belongings.map((row, index) => (
                  <li
                    key={row.key}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">#{index + 1}</span>
                        <span className="font-medium">{row.name}</span>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {row.id}
                        </Badge>
                        {row.chargePercent !== "" ? (
                          <Badge variant="secondary">充電 {row.chargePercent}%</Badge>
                        ) : (
                          <Badge variant="outline">充電不要</Badge>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeBelonging(row.key)}
                    >
                      削除
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {artifact?.normalizedInput !== undefined ? (
            <>
              <Separator />
              <div className="space-y-1.5">
                <Label>保存済み normalizedInput</Label>
                <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs">
                  {JSON.stringify(artifact.normalizedInput, null, 2)}
                </pre>
              </div>
            </>
          ) : null}

          <Button
            disabled={busy || form.belongings.length === 0}
            onClick={() => void handleNormalize()}
          >
            {busy ? "Normalizing…" : "Normalize & continue"}
          </Button>
        </CardContent>
      </Card>

      <AddBelongingModal
        open={addOpen}
        planId={planId}
        onClose={() => setAddOpen(false)}
        onAdd={handleAddRows}
      />
    </>
  );
}
