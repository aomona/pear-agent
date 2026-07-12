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
            <p className="text-xs text-muted-foreground">
              {OUTING_PRESETS.map((p) => `${p.label}: ${p.description}`).join(" · ")}
            </p>
          </div>

          <InputSummary form={form} />

          {/* Departure */}
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

          {/* Places */}
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
            <p className="text-xs text-muted-foreground">
              AI は短い地名ラベルに整形（Gemini）。空でも Normalize 可能です。
            </p>
          </section>

          {/* Prep list */}
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
                まだ項目がありません。持ち物やタスクを追加してください。
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
                    onChange={(patch) =>
                      setForm((f) => ({
                        ...f,
                        items: f.items.map((r) => (r.key === row.key ? { ...r, ...patch } : r)),
                      }))
                    }
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

function PrepListItem({
  row,
  index,
  onRemove,
  onRetry,
  onChange,
}: {
  row: PrepListRow;
  index: number;
  onRemove: () => void;
  onRetry: () => void;
  onChange: (patch: Partial<PrepListRow>) => void;
}) {
  const kindBadge = row.kind === "belonging" ? "持ち物" : "タスク";
  const [editing, setEditing] = useState(false);

  if (row.status === "pending") {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-amber-300 bg-amber-50/80 px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">#{index + 1}</span>
            <Badge variant="outline">{kindBadge}</Badge>
            <Badge variant="warning">Gemini 生成中…</Badge>
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {row.freeTextPreview ?? row.name}
          </p>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          キャンセル
        </Button>
      </li>
    );
  }

  if (row.status === "error") {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-red-50/80 px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">#{index + 1}</span>
            <Badge variant="outline">{kindBadge}</Badge>
            <Badge variant="destructive">失敗</Badge>
          </div>
          <p className="truncate text-sm">{row.freeTextPreview ?? row.name}</p>
          {row.errorMessage ? <p className="text-xs text-destructive">{row.errorMessage}</p> : null}
        </div>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            再試行
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            削除
          </Button>
        </div>
      </li>
    );
  }

  if (editing) {
    return (
      <li className="space-y-2 rounded-md border border-primary/30 bg-background px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">#{index + 1}</span>
          <Badge variant="secondary">{kindBadge}</Badge>
          <span className="text-xs text-muted-foreground">編集中</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input
            value={row.name}
            placeholder={row.kind === "task" ? "タスク名" : "名前"}
            onChange={(e) => onChange({ name: e.target.value })}
          />
          <Input
            className="font-mono text-sm"
            value={row.id}
            placeholder="id"
            onChange={(e) => onChange({ id: e.target.value })}
          />
          {row.kind === "belonging" ? (
            <Input
              type="number"
              min={0}
              max={100}
              placeholder="充電%"
              value={row.chargePercent}
              onChange={(e) => onChange({ chargePercent: e.target.value })}
            />
          ) : (
            <Input
              type="number"
              min={1}
              placeholder="所要秒"
              value={row.estimatedDurationSeconds}
              onChange={(e) => onChange({ estimatedDurationSeconds: e.target.value })}
            />
          )}
        </div>
        {row.kind === "task" ? (
          <Input
            placeholder="メモ"
            value={row.notes}
            onChange={(e) => onChange({ notes: e.target.value })}
          />
        ) : null}
        <div className="flex justify-end gap-1">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
            完了
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            削除
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">#{index + 1}</span>
          <Badge variant="secondary">{kindBadge}</Badge>
          <span className="font-medium">{row.name}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {row.id}
          </Badge>
          {row.kind === "belonging" ? (
            row.chargePercent !== "" ? (
              <Badge variant="outline">充電 {row.chargePercent}%</Badge>
            ) : (
              <Badge variant="outline">充電不要</Badge>
            )
          ) : (
            <>
              {row.estimatedDurationSeconds !== "" ? (
                <Badge variant="outline">{row.estimatedDurationSeconds}s</Badge>
              ) : null}
              {row.notes ? (
                <span className="truncate text-xs text-muted-foreground">{row.notes}</span>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div className="flex gap-1">
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
          編集
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          削除
        </Button>
      </div>
    </li>
  );
}
