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
import type { AddPrepSubmit } from "./add-prep-modal";

type StructureVariables = { pendingKey: string; itemKind: ItemKind; freeText: string };

function createDefaultForm(): OutingFormState {
  return {
    departureMode: "structured",
    departureLocal: defaultDepartureLocal(),
    departureFreeText: "tomorrow morning 10:00",
    originLabel: "",
    destinationLabel: "",
    items: [],
  };
}

export function usePlanInputController(input: {
  planId: string;
  artifact: PlanArtifactDetail | null;
  onPlanBuilt: (artifact: PlanArtifactDetail) => void;
}) {
  const { planId, artifact, onPlanBuilt } = input;
  const { client } = usePearContext();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(createDefaultForm);
  const [buildBusy, setBuildBusy] = useState(false);
  const [placeBusy, setPlaceBusy] = useState<"origin" | "destination" | null>(null);
  const hydratedPlanId = useRef<string | null>(null);

  useEffect(() => {
    hydratedPlanId.current = null;
    setForm(createDefaultForm());
  }, [planId]);

  useEffect(() => {
    if (artifact === null || hydratedPlanId.current === planId) return;
    hydratedPlanId.current = planId;
    const saved = artifact.normalizedInput;
    if (!saved || typeof saved !== "object") return;
    try {
      setForm(formStateFromNormalized(saved as Parameters<typeof formStateFromNormalized>[0]));
    } catch {
      // Keep defaults when a legacy artifact has an incompatible normalized-input shape.
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
      setForm((current) => ({
        ...current,
        items: current.items.flatMap((row) => (row.key === variables.pendingKey ? rows : [row])),
      }));
      toast.success(rows.length === 1 ? "追加しました" : `${rows.length} 件追加しました`);
    },
    onError: (error, variables) => {
      const message = error instanceof Error ? error.message : String(error);
      setForm((current) => ({
        ...current,
        items: current.items.map((row) =>
          row.key === variables.pendingKey
            ? { ...row, status: "error" as const, errorMessage: message }
            : row,
        ),
      }));
      toast.error(message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["outing", planId] });
    },
  });

  function submitPrepItem(result: AddPrepSubmit) {
    if (result.kind === "ready") {
      setForm((current) => ({ ...current, items: [...current.items, ...result.rows] }));
      toast.success("項目を追加しました");
      return;
    }
    const pending = createPendingRow(result.itemKind, result.freeText);
    setForm((current) => ({ ...current, items: [...current.items, pending] }));
    structureMutation.mutate({
      pendingKey: pending.key,
      itemKind: result.itemKind,
      freeText: result.freeText,
    });
  }

  function removeItem(key: string) {
    setForm((current) => ({
      ...current,
      items: current.items.filter((row) => row.key !== key),
    }));
  }

  function retryItem(row: PrepListRow) {
    if (row.status !== "error" || !row.freeTextPreview) return;
    const freeText = row.freeTextPreview;
    setForm((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.key === row.key
          ? { ...item, status: "pending" as const, errorMessage: undefined }
          : item,
      ),
    }));
    structureMutation.mutate({ pendingKey: row.key, itemKind: row.kind, freeText });
  }

  function patchItem(key: string, patch: Partial<PrepListRow>) {
    setForm((current) => ({
      ...current,
      items: current.items.map((row) =>
        row.key === key ? ({ ...row, ...patch } as PrepListRow) : row,
      ),
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
        typeof resolved.value === "string" ? resolved.value : parsePlaceLabel(resolved.value);
      setForm((current) =>
        which === "origin"
          ? { ...current, originLabel: label }
          : { ...current, destinationLabel: label },
      );
      toast.success(`${which === "origin" ? "出発地" : "目的地"}を整えました`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPlaceBusy(null);
    }
  }

  async function buildPlan() {
    setBuildBusy(true);
    try {
      const normalized = buildOutingInputFromForm(form);
      const generated = await client.buildPlanArtifact(planId, normalized);
      toast.success(generateSuccessMessage(generated.currentPlan));
      onPlanBuilt(generated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBuildBusy(false);
    }
  }

  const inFlight = hasInFlightItems(form.items);
  const canBuild =
    readyItems(form.items).length > 0 && !inFlight && !hasFailedItems(form.items) && !buildBusy;
  return {
    form,
    setForm,
    buildBusy,
    placeBusy,
    inFlight,
    canBuild,
    submitPrepItem,
    removeItem,
    retryItem,
    patchItem,
    resolvePlace,
    buildPlan,
  };
}

function parsePlaceLabel(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "label" in value) {
    const label = (value as { label: unknown }).label;
    if (typeof label === "string" && label.trim()) return label.trim();
  }
  throw new Error("Place label could not be parsed from Gemini response");
}
