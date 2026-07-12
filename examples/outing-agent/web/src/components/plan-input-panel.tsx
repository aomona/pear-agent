import { useMutation } from "@tanstack/react-query";
import { usePearContext, type PlanArtifactDetail } from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import {
  belongingServerValueToRows,
  buildOutingInputFromForm,
  createPendingBelongingRow,
  defaultDepartureLocal,
  hasFailedBelongings,
  hasInFlightBelongings,
  readyBelongings,
  type BelongingFormRow,
  type OutingFormState,
} from "../lib/build-outing-input";
import { AddBelongingModal, type AddBelongingSubmit } from "./add-belonging-modal";
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
  freeText: string;
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
  const [normalizeBusy, setNormalizeBusy] = useState(false);

  const structureMutation = useMutation({
    mutationKey: ["outing", "structure-belonging", planId],
    mutationFn: async ({ freeText }: StructureVariables) => {
      const resolved = await client.resolvePlanField(planId, {
        field: "belongings",
        freeText,
      });
      return belongingServerValueToRows(resolved.value);
    },
    // Allow several Gemini jobs at once; each call tracks its own pendingKey via variables.
    onSuccess: (rows, variables) => {
      setForm((f) => ({
        ...f,
        belongings: f.belongings.flatMap((row) =>
          row.key === variables.pendingKey ? rows.map((r) => ({ ...r, key: r.key })) : [row],
        ),
      }));
      toast.success(rows.length === 1 ? "構造化完了" : `構造化完了（${rows.length} 件）`);
    },
    onError: (error, variables) => {
      const message = error instanceof Error ? error.message : String(error);
      setForm((f) => ({
        ...f,
        belongings: f.belongings.map((row) =>
          row.key === variables.pendingKey
            ? {
                ...row,
                status: "error" as const,
                errorMessage: message,
              }
            : row,
        ),
      }));
      toast.error(message);
    },
  });

  function handleModalSubmit(result: AddBelongingSubmit) {
    if (result.kind === "ready") {
      setForm((f) => ({ ...f, belongings: [...f.belongings, ...result.rows] }));
      toast.success("アイテムを追加しました");
      return;
    }

    // Optimistic UI: show pending row immediately, then Gemini in background.
    const pending = createPendingBelongingRow(result.freeText);
    setForm((f) => ({ ...f, belongings: [...f.belongings, pending] }));
    structureMutation.mutate({ pendingKey: pending.key, freeText: result.freeText });
  }

  function removeBelonging(key: string) {
    setForm((f) => ({
      ...f,
      belongings: f.belongings.filter((r) => r.key !== key),
    }));
  }

  function retryBelonging(row: BelongingFormRow) {
    if (row.status !== "error" || !row.freeTextPreview) return;
    const freeText = row.freeTextPreview;
    setForm((f) => ({
      ...f,
      belongings: f.belongings.map((r) =>
        r.key === row.key
          ? {
              ...r,
              status: "pending" as const,
              errorMessage: undefined,
            }
          : r,
      ),
    }));
    structureMutation.mutate({ pendingKey: row.key, freeText });
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

  const inFlight = hasInFlightBelongings(form.belongings);
  const hasFailed = hasFailedBelongings(form.belongings);
  const readyCount = readyBelongings(form.belongings).length;
  const canNormalize = readyCount > 0 && !inFlight && !hasFailed && !normalizeBusy;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>2. What to prepare</CardTitle>
              <CardDescription>
                持ち物は追加ですぐ一覧表示。自由文は「Gemini 生成中…」のまま複数並行できます。
                {artifact?.normalizedInput ? " 保存済み normalizedInput あり。" : ""}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={onBack}>
              Back to list
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
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

          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">持ち物</h3>
                <p className="text-xs text-muted-foreground">
                  追加 → 一覧に即表示 → Gemini は裏で並行（TanStack Query mutation）
                </p>
              </div>
              <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
                ＋ 追加
              </Button>
            </div>

            {form.belongings.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                まだアイテムがありません。「＋ 追加」から入れてください（複数並行 OK）。
              </p>
            ) : (
              <ul className="space-y-2">
                {form.belongings.map((row, index) => (
                  <BelongingListItem
                    key={row.key}
                    row={row}
                    index={index}
                    onRemove={() => removeBelonging(row.key)}
                    onRetry={() => retryBelonging(row)}
                  />
                ))}
              </ul>
            )}

            {inFlight ? (
              <p className="text-xs text-muted-foreground">
                Gemini で構造化中の項目があります。完了を待たずに別の追加もできます。
              </p>
            ) : null}
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

          <Button disabled={!canNormalize} onClick={() => void handleNormalize()}>
            {normalizeBusy
              ? "Normalizing…"
              : inFlight
                ? "生成完了を待っています…"
                : "Normalize & continue"}
          </Button>
        </CardContent>
      </Card>

      <AddBelongingModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={handleModalSubmit}
      />
    </>
  );
}

function BelongingListItem({
  row,
  index,
  onRemove,
  onRetry,
}: {
  row: BelongingFormRow;
  index: number;
  onRemove: () => void;
  onRetry: () => void;
}) {
  if (row.status === "pending") {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-amber-300 bg-amber-50/80 px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">#{index + 1}</span>
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

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2">
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
      <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
        削除
      </Button>
    </li>
  );
}
