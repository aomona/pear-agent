import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePearContext, type PlanArtifactDetail } from "@pear-agent/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  belongingServerValueToRows,
  buildOutingInputFromForm,
  createPendingRow,
  defaultDepartureLocal,
  formStateFromNormalized,
  hasFailedItems,
  hasInFlightItems,
  readyItems,
  taskServerValueToRows,
  type ItemKind,
  type OutingFormState,
  type PrepListRow,
} from "../lib/build-outing-input";
import { generateSuccessMessage } from "../lib/order-meta";
import { OUTING_PRESETS } from "../lib/presets";
import { AddPrepModal, type AddPrepSubmit } from "./add-prep-modal";
import { InputSummary } from "./input-summary";
import { DepartureFields, PlaceFields } from "./plan-input-fields";
import { PrepListItem } from "./prep-list-item";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

type PlanInputPanelProps = {
  planId: string;
  artifact: PlanArtifactDetail | null;
  /** Called after normalize + generate succeed. */
  onPlanBuilt: (artifact: PlanArtifactDetail) => void;
  onBack: () => void;
};

type StructureVariables = {
  pendingKey: string;
  itemKind: ItemKind;
  freeText: string;
};

export function PlanInputPanel({ planId, artifact, onPlanBuilt, onBack }: PlanInputPanelProps) {
  const { client } = usePearContext();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<OutingFormState>({
    departureMode: "structured",
    departureLocal: defaultDepartureLocal(),
    departureFreeText: "tomorrow morning 10:00",
    originLabel: "",
    destinationLabel: "",
    items: [],
  });
  const [addOpen, setAddOpen] = useState(false);
  const [buildBusy, setBuildBusy] = useState(false);
  const [placeBusy, setPlaceBusy] = useState<"origin" | "destination" | null>(null);
  const hydratedPlanId = useRef<string | null>(null);

  // Reset hydrate guard when switching plans.
  useEffect(() => {
    hydratedPlanId.current = null;
    setForm({
      departureMode: "structured",
      departureLocal: defaultDepartureLocal(),
      departureFreeText: "tomorrow morning 10:00",
      originLabel: "",
      destinationLabel: "",
      items: [],
    });
  }, [planId]);

  // Resume editing from saved normalizedInput once artifact is loaded for this plan.
  useEffect(() => {
    if (artifact === null) return;
    if (hydratedPlanId.current === planId) return;
    hydratedPlanId.current = planId;
    const saved = artifact.normalizedInput;
    if (!saved || typeof saved !== "object") return;
    try {
      setForm(formStateFromNormalized(saved as Parameters<typeof formStateFromNormalized>[0]));
    } catch {
      // keep defaults if shape is unexpected
    }
  }, [planId, artifact]);

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
      toast.success(rows.length === 1 ? "追加しました" : `${rows.length} 件追加しました`);
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
    onSettled: () => {
      // Local form is SoT for prep rows; invalidate any plan-scoped caches.
      void queryClient.invalidateQueries({ queryKey: ["outing", planId] });
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
      toast.success(`${which === "origin" ? "出発地" : "目的地"}を整えました`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPlaceBusy(null);
    }
  }

  /** Main path: save input + generate ordered plan in one action. */
  async function handleBuildPlan() {
    setBuildBusy(true);
    try {
      const input = buildOutingInputFromForm(form);
      await client.normalizePlanInput(planId, input);
      const generated = await client.generatePlanArtifact(planId);
      toast.success(generateSuccessMessage(generated.currentPlan));
      onPlanBuilt(generated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBuildBusy(false);
    }
  }

  const inFlight = hasInFlightItems(form.items);
  const hasFailed = hasFailedItems(form.items);
  const readyCount = readyItems(form.items).length;
  const canBuild = readyCount > 0 && !inFlight && !hasFailed && !buildBusy;

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
            onResolvePlace={(which) => void resolvePlace(which)}
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
                    onRemove={() => removeItem(row.key)}
                    onRetry={() => retryItem(row)}
                    onChange={(patch) => patchItem(row.key, patch)}
                  />
                ))}
              </ul>
            )}
          </section>

          <div className="space-y-2">
            <Button
              className="w-full sm:w-auto"
              disabled={!canBuild}
              onClick={() => void handleBuildPlan()}
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
