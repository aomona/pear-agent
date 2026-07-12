import { useMutation } from "@tanstack/react-query";
import { usePearContext, type PlanArtifactDetail } from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import {
  belongingServerValueToRows,
  buildOutingInputFromForm,
  createPendingRow,
  defaultDepartureLocal,
  hasFailedItems,
  hasInFlightItems,
  readyItems,
  taskServerValueToRows,
  type ItemKind,
  type OutingFormState,
  type PrepListRow,
} from "../lib/build-outing-input";
import { OUTING_PRESETS } from "../lib/presets";
import { AddPrepModal, type AddPrepSubmit } from "./add-prep-modal";
import { InputSummary } from "./input-summary";
import { PrepListItem } from "./prep-list-item";
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

type StructureVariables = {
  pendingKey: string;
  itemKind: ItemKind;
  freeText: string;
};

export function PlanInputPanel({ planId, artifact, onNormalized, onBack }: PlanInputPanelProps) {
  const { client } = usePearContext();
  const [form, setForm] = useState<OutingFormState>({
    departureMode: "structured",
    departureLocal: defaultDepartureLocal(),
    departureFreeText: "tomorrow morning 10:00",
    originLabel: "",
    destinationLabel: "",
    items: [],
  });
  const [addOpen, setAddOpen] = useState(false);
  const [normalizeBusy, setNormalizeBusy] = useState(false);
  const [placeBusy, setPlaceBusy] = useState<"origin" | "destination" | null>(null);

  const structureMutation = useMutation({
    mutationKey: ["outing", "structure-prep", planId],
    mutationFn: async ({ itemKind, freeText }: StructureVariables) => {
      const field = itemKind === "belonging" ? "belongings" : "tasks";
      const resolved = await client.resolvePlanField(planId, { field, freeText });
      return itemKind === "belonging"
        ? belongingServerValueToRows(resolved.value)
        : taskServerValueToRows(resolved.value);
    },
    onSuccess: (rows, variables) => {
      setForm((f) => ({
        ...f,
        items: f.items.flatMap((row) => (row.key === variables.pendingKey ? rows : [row])),
      }));
      toast.success(rows.length === 1 ? "構造化完了" : `構造化完了（${rows.length} 件）`);
    },
    onError: (error, variables) => {
      const message = error instanceof Error ? error.message : String(error);
      setForm((f) => ({
        ...f,
        items: f.items.map((row) =>
          row.key === variables.pendingKey
            ? { ...row, status: "error" as const, errorMessage: message }
            : row,
        ),
      }));
      toast.error(message);
    },
  });

  function handleModalSubmit(result: AddPrepSubmit) {
    if (result.kind === "ready") {
      setForm((f) => ({ ...f, items: [...f.items, ...result.rows] }));
      toast.success("項目を追加しました");
      return;
    }
    const pending = createPendingRow(result.itemKind, result.freeText);
    setForm((f) => ({ ...f, items: [...f.items, pending] }));
    structureMutation.mutate({
      pendingKey: pending.key,
      itemKind: result.itemKind,
      freeText: result.freeText,
    });
  }

  function removeItem(key: string) {
    setForm((f) => ({ ...f, items: f.items.filter((r) => r.key !== key) }));
  }

  function retryItem(row: PrepListRow) {
    if (row.status !== "error" || !row.freeTextPreview) return;
    const freeText = row.freeTextPreview;
    setForm((f) => ({
      ...f,
      items: f.items.map((r) =>
        r.key === row.key ? { ...r, status: "pending" as const, errorMessage: undefined } : r,
      ),
    }));
    structureMutation.mutate({
      pendingKey: row.key,
      itemKind: row.kind,
      freeText,
    });
  }

  function patchItem(key: string, patch: Partial<PrepListRow>) {
    setForm((f) => ({
      ...f,
      items: f.items.map((r) => {
        if (r.key !== key) return r;
        return { ...r, ...patch } as PrepListRow;
      }),
    }));
  }

  async function resolvePlace(which: "origin" | "destination") {
    const raw = which === "origin" ? form.originLabel.trim() : form.destinationLabel.trim();
    if (!raw) {
      toast.error(which === "origin" ? "出発地を入力してください" : "目的地を入力してください");
      return;
    }
    setPlaceBusy(which);
    try {
      const field = which === "origin" ? "originLabel" : "destinationLabel";
      const resolved = await client.resolvePlanField(planId, { field, freeText: raw });
      const label =
        typeof resolved.value === "string" ? resolved.value : zPlaceLabel(resolved.value);
      setForm((f) =>
        which === "origin" ? { ...f, originLabel: label } : { ...f, destinationLabel: label },
      );
      toast.success(`${which === "origin" ? "出発地" : "目的地"}を構造化しました`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPlaceBusy(null);
    }
  }

  async function handleNormalize() {
    setNormalizeBusy(true);
    try {
      const input = buildOutingInputFromForm(form);
      const next = await client.normalizePlanInput(planId, input);
      toast.success("Input normalized and saved on plan");
      onNormalized(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setNormalizeBusy(false);
    }
  }

  const inFlight = hasInFlightItems(form.items);
  const hasFailed = hasFailedItems(form.items);
  const readyCount = readyItems(form.items).length;
  const canNormalize = readyCount > 0 && !inFlight && !hasFailed && !normalizeBusy;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>2. What to prepare</CardTitle>
              <CardDescription>
                出発・行き先・持ち物・準備タスク。リスト項目は並行で Gemini 構造化できます。
                {artifact?.normalizedInput ? " 保存済み normalizedInput あり。" : ""}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={onBack}>
              Back to list
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

          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">出発時刻</h3>
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
              <Input
                type="datetime-local"
                value={form.departureLocal}
                onChange={(e) => setForm((f) => ({ ...f, departureLocal: e.target.value }))}
              />
            ) : (
              <Input
                placeholder="例: 明日の朝10時"
                value={form.departureFreeText}
                onChange={(e) => setForm((f) => ({ ...f, departureFreeText: e.target.value }))}
              />
            )}
          </section>

          <section className="space-y-3 rounded-lg border p-4">
            <h3 className="text-sm font-semibold">行き先</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="origin">出発地</Label>
                <div className="flex gap-2">
                  <Input
                    id="origin"
                    placeholder="Home / 渋谷"
                    value={form.originLabel}
                    onChange={(e) => setForm((f) => ({ ...f, originLabel: e.target.value }))}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={placeBusy !== null}
                    onClick={() => void resolvePlace("origin")}
                  >
                    {placeBusy === "origin" ? "…" : "AI"}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dest">目的地</Label>
                <div className="flex gap-2">
                  <Input
                    id="dest"
                    placeholder="Office / 横浜"
                    value={form.destinationLabel}
                    onChange={(e) => setForm((f) => ({ ...f, destinationLabel: e.target.value }))}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={placeBusy !== null}
                    onClick={() => void resolvePlace("destination")}
                  >
                    {placeBusy === "destination" ? "…" : "AI"}
                  </Button>
                </div>
              </div>
            </div>
          </section>

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
                    onRemove={() => removeItem(row.key)}
                    onRetry={() => retryItem(row)}
                    onChange={(patch) => patchItem(row.key, patch)}
                  />
                ))}
              </ul>
            )}
          </section>

          {artifact?.normalizedInput !== undefined ? (
            <>
              <Separator />
              <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs">
                {JSON.stringify(artifact.normalizedInput, null, 2)}
              </pre>
            </>
          ) : null}

          <Button disabled={!canNormalize} onClick={() => void handleNormalize()}>
            {normalizeBusy
              ? "Normalizing…"
              : inFlight
                ? "生成完了を待っています…"
                : "Normalize & continue"}
          </Button>
        </CardContent>
      </Card>

      <AddPrepModal open={addOpen} onClose={() => setAddOpen(false)} onSubmit={handleModalSubmit} />
    </>
  );
}

function zPlaceLabel(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "label" in value) {
    const label = (value as { label: unknown }).label;
    if (typeof label === "string" && label.trim()) return label.trim();
  }
  throw new Error("Place label could not be parsed from Gemini response");
}
