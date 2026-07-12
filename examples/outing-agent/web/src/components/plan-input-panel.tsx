import { usePearContext, type PlanArtifactDetail } from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import {
  buildOutingInputFromForm,
  createEmptyBelongingRow,
  defaultBelongingRows,
  defaultDepartureLocal,
  slugFromName,
  type BelongingFormRow,
  type OutingFormState,
} from "../lib/build-outing-input";
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
    belongingsMode: "items",
    departureLocal: defaultDepartureLocal(),
    departureFreeText: "tomorrow morning 10:00",
    belongings: defaultBelongingRows(),
    belongingsFreeText: "keys and phone at 30 percent, wallet",
  });
  const [busy, setBusy] = useState(false);

  function updateBelonging(key: string, patch: Partial<Omit<BelongingFormRow, "key">>) {
    setForm((f) => ({
      ...f,
      belongings: f.belongings.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));
  }

  function addBelonging() {
    setForm((f) => ({
      ...f,
      belongings: [...f.belongings, createEmptyBelongingRow()],
    }));
  }

  function removeBelonging(key: string) {
    setForm((f) => ({
      ...f,
      belongings:
        f.belongings.length <= 1 ? f.belongings : f.belongings.filter((r) => r.key !== key),
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
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>2. What to prepare</CardTitle>
            <CardDescription>
              項目ごとに入力欄を分けています。Normalize は Worker（決定論 → 必要なら Gemini）。
              {artifact?.normalizedInput ? " 保存済みの normalizedInput あり。" : ""}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to list
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* --- Departure (one field) --- */}
        <section className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">出発時刻</h3>
              <p className="text-xs text-muted-foreground">この項目だけを入力します</p>
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
                placeholder="例: 明日の朝10時 / tomorrow 10am"
                value={form.departureFreeText}
                onChange={(e) => setForm((f) => ({ ...f, departureFreeText: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                ISO や Date が分かる文はキーなし。曖昧な相対時刻は GEMINI_API_KEY が必要です。
              </p>
            </div>
          )}
        </section>

        {/* --- Belongings (one item = one row of fields) --- */}
        <section className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">持ち物</h3>
              <p className="text-xs text-muted-foreground">
                1 行 = 1 アイテム（名前 / id / 充電%）
              </p>
            </div>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={form.belongingsMode === "items" ? "default" : "outline"}
                onClick={() => setForm((f) => ({ ...f, belongingsMode: "items" }))}
              >
                項目ごと
              </Button>
              <Button
                type="button"
                size="sm"
                variant={form.belongingsMode === "freeText" ? "default" : "outline"}
                onClick={() => setForm((f) => ({ ...f, belongingsMode: "freeText" }))}
              >
                まとめて自由文
              </Button>
            </div>
          </div>

          {form.belongingsMode === "items" ? (
            <div className="space-y-3">
              {form.belongings.map((row, index) => (
                <div
                  key={row.key}
                  className="space-y-2 rounded-md border border-dashed bg-muted/30 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      アイテム {index + 1}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={form.belongings.length <= 1}
                      onClick={() => removeBelonging(row.key)}
                    >
                      削除
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5 sm:col-span-1">
                      <Label htmlFor={`name-${row.key}`}>名前</Label>
                      <Input
                        id={`name-${row.key}`}
                        placeholder="Phone"
                        value={row.name}
                        onChange={(e) => {
                          const name = e.target.value;
                          // Auto-fill id only while user has not typed a custom id.
                          const autoId = slugFromName(name);
                          const prevAuto = slugFromName(row.name);
                          const shouldSyncId = !row.id || row.id === prevAuto;
                          updateBelonging(row.key, {
                            name,
                            ...(shouldSyncId ? { id: autoId } : {}),
                          });
                        }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`id-${row.key}`}>id</Label>
                      <Input
                        id={`id-${row.key}`}
                        placeholder="phone"
                        className="font-mono text-sm"
                        value={row.id}
                        onChange={(e) => updateBelonging(row.key, { id: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`charge-${row.key}`}>充電 %（任意）</Label>
                      <Input
                        id={`charge-${row.key}`}
                        type="number"
                        min={0}
                        max={100}
                        placeholder="不要なら空"
                        value={row.chargePercent}
                        onChange={(e) =>
                          updateBelonging(row.key, { chargePercent: e.target.value })
                        }
                      />
                    </div>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addBelonging}>
                ＋ アイテムを追加
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="belongings-free">持ち物を自然文でまとめて</Label>
              <textarea
                id="belongings-free"
                className="flex min-h-[96px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.belongingsFreeText}
                onChange={(e) => setForm((f) => ({ ...f, belongingsFreeText: e.target.value }))}
                placeholder="例: 鍵とスマホ（残量30%）、財布"
              />
              <p className="text-xs text-muted-foreground">
                曖昧な文は Gemini が構造化します（API キー必要）。通常は「項目ごと」の方が確実です。
              </p>
            </div>
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

        <Button disabled={busy} onClick={() => void handleNormalize()}>
          {busy ? "Normalizing…" : "Normalize & continue"}
        </Button>
      </CardContent>
    </Card>
  );
}
