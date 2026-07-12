import type {
  OutingBelongingInput,
  OutingInput,
  OutingTaskInput,
} from "@pear-agent/outing-domain-example";
import { z } from "zod";

export type ItemKind = "belonging" | "task";
export type RowStatus = "ready" | "pending" | "error";

type RowBase = {
  key: string;
  status: RowStatus;
  freeTextPreview?: string | undefined;
  errorMessage?: string | undefined;
};

export type BelongingListRow = RowBase & {
  kind: "belonging";
  id: string;
  name: string;
  chargePercent: string;
};

export type TaskListRow = RowBase & {
  kind: "task";
  id: string;
  title: string;
  estimatedDurationSeconds: string;
  notes: string;
};

export type PrepListRow = BelongingListRow | TaskListRow;

export type OutingFormState = {
  departureMode: "structured" | "freeText";
  departureLocal: string;
  departureFreeText: string;
  originLabel: string;
  destinationLabel: string;
  items: PrepListRow[];
};

export function defaultDepartureLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function newRowKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export function createEmptyBelongingRow(
  partial?: Partial<Omit<BelongingListRow, "key" | "kind">>,
): BelongingListRow {
  return {
    key: newRowKey(),
    kind: "belonging",
    status: partial?.status ?? "ready",
    freeTextPreview: partial?.freeTextPreview,
    errorMessage: partial?.errorMessage,
    id: partial?.id ?? "",
    name: partial?.name ?? "",
    chargePercent: partial?.chargePercent ?? "",
  };
}

export function createEmptyTaskRow(
  partial?: Partial<Omit<TaskListRow, "key" | "kind">>,
): TaskListRow {
  return {
    key: newRowKey(),
    kind: "task",
    status: partial?.status ?? "ready",
    freeTextPreview: partial?.freeTextPreview,
    errorMessage: partial?.errorMessage,
    id: partial?.id ?? "",
    title: partial?.title ?? "",
    estimatedDurationSeconds: partial?.estimatedDurationSeconds ?? "",
    notes: partial?.notes ?? "",
  };
}

export function createPendingRow(kind: ItemKind, freeText: string): PrepListRow {
  const preview = freeText.trim();
  if (kind === "belonging") {
    return createEmptyBelongingRow({
      status: "pending",
      freeTextPreview: preview,
      name: preview,
    });
  }
  return createEmptyTaskRow({
    status: "pending",
    freeTextPreview: preview,
    title: preview,
  });
}

export function displayName(row: PrepListRow): string {
  return row.kind === "belonging" ? row.name : row.title;
}

export type AddPrepModalDraft = {
  kind: ItemKind;
  freeText: string;
  name: string;
  id: string;
  chargePercent: string;
  title: string;
  taskId: string;
  estimatedDurationSeconds: string;
  notes: string;
};

export type AddPrepLocalResult =
  | { kind: "needs_gemini"; itemKind: ItemKind; freeText: string }
  | { kind: "structured"; rows: PrepListRow[] };

export function resolveAddPrepModalLocal(draft: AddPrepModalDraft): AddPrepLocalResult {
  const free = draft.freeText.trim();
  if (free) {
    return { kind: "needs_gemini", itemKind: draft.kind, freeText: free };
  }

  if (draft.kind === "belonging") {
    const name = draft.name.trim();
    if (!name) throw new Error("自由文か、名前を入力してください");
    const id = draft.id.trim() || slugFromName(name);
    if (!id) throw new Error("id を入力するか、名前から生成できる文字列にしてください");
    const chargeRaw = draft.chargePercent.trim();
    if (chargeRaw !== "") {
      const charge = Number(chargeRaw);
      if (Number.isNaN(charge) || charge < 0 || charge > 100) {
        throw new Error("充電%は 0〜100 で入力してください");
      }
    }
    return {
      kind: "structured",
      rows: [createEmptyBelongingRow({ status: "ready", id, name, chargePercent: chargeRaw })],
    };
  }

  const title = draft.title.trim();
  if (!title) throw new Error("自由文か、タスク名を入力してください");
  const id = draft.taskId.trim() || slugFromName(title);
  if (!id) throw new Error("id を入力するか、タイトルから生成できる文字列にしてください");
  const durRaw = draft.estimatedDurationSeconds.trim();
  if (durRaw !== "") {
    const dur = Number(durRaw);
    if (Number.isNaN(dur) || dur <= 0) {
      throw new Error("所要秒は正の数で入力してください");
    }
  }
  return {
    kind: "structured",
    rows: [
      createEmptyTaskRow({
        status: "ready",
        id,
        title,
        estimatedDurationSeconds: durRaw,
        notes: draft.notes.trim(),
      }),
    ],
  };
}

export function belongingServerValueToRows(value: unknown): BelongingListRow[] {
  const items = z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        chargePercent: z.number().min(0).max(100).optional(),
      }),
    )
    .min(1)
    .parse(value);
  return items.map((item) =>
    createEmptyBelongingRow({
      status: "ready",
      id: item.id,
      name: item.name,
      chargePercent: item.chargePercent === undefined ? "" : String(item.chargePercent),
    }),
  );
}

export function taskServerValueToRows(value: unknown): TaskListRow[] {
  const items = z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        estimatedDurationSeconds: z.number().positive().optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1)
    .parse(value);
  return items.map((item) =>
    createEmptyTaskRow({
      status: "ready",
      id: item.id,
      title: item.title,
      estimatedDurationSeconds:
        item.estimatedDurationSeconds === undefined ? "" : String(item.estimatedDurationSeconds),
      notes: item.notes ?? "",
    }),
  );
}

export function readyItems(rows: readonly PrepListRow[]): PrepListRow[] {
  return rows.filter((row) => row.status === "ready");
}

export function hasInFlightItems(rows: readonly PrepListRow[]): boolean {
  return rows.some((row) => row.status === "pending");
}

export function hasFailedItems(rows: readonly PrepListRow[]): boolean {
  return rows.some((row) => row.status === "error");
}

/** ISO datetime → `datetime-local` value (local wall clock). */
export function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return defaultDepartureLocal();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Rebuild the input form from a saved normalized plan input (structured only). */
export function formStateFromNormalized(input: {
  departureAt: string;
  belongings: Array<{ id: string; name: string; chargePercent?: number | null }>;
  tasks: Array<{
    id: string;
    title: string;
    estimatedDurationSeconds?: number | null;
    notes?: string | null;
  }>;
  originLabel?: string | null;
  destinationLabel?: string | null;
}): OutingFormState {
  const items: PrepListRow[] = [
    ...input.belongings.map((b) =>
      createEmptyBelongingRow({
        status: "ready",
        id: b.id,
        name: b.name,
        chargePercent:
          b.chargePercent === null || b.chargePercent === undefined ? "" : String(b.chargePercent),
      }),
    ),
    ...input.tasks.map((t) =>
      createEmptyTaskRow({
        status: "ready",
        id: t.id,
        title: t.title,
        estimatedDurationSeconds:
          t.estimatedDurationSeconds === null || t.estimatedDurationSeconds === undefined
            ? ""
            : String(t.estimatedDurationSeconds),
        notes: t.notes ?? "",
      }),
    ),
  ];

  return {
    departureMode: "structured",
    departureLocal: isoToDatetimeLocal(input.departureAt),
    departureFreeText: "",
    originLabel: input.originLabel ?? "",
    destinationLabel: input.destinationLabel ?? "",
    items,
  };
}

export function buildOutingInputFromForm(form: OutingFormState): OutingInput {
  if (hasInFlightItems(form.items)) {
    throw new Error("Gemini で構造化中の項目があります。完了を待ってください");
  }
  if (hasFailedItems(form.items)) {
    throw new Error("構造化に失敗した項目があります。削除するか再試行してください");
  }

  const departureAt: OutingInput["departureAt"] =
    form.departureMode === "freeText"
      ? { freeText: form.departureFreeText.trim() }
      : new Date(form.departureLocal).toISOString();

  if (form.departureMode === "freeText" && !form.departureFreeText.trim()) {
    throw new Error("出発時刻の自由文を入力してください");
  }

  const belongings: OutingBelongingInput[] = [];
  const tasks: OutingTaskInput[] = [];

  for (const row of readyItems(form.items)) {
    if (row.kind === "belonging") {
      const name = row.name.trim();
      if (!name) continue;
      const id = row.id.trim() || slugFromName(name);
      if (!id) throw new Error(`「${name}」の id を確認してください`);
      const item: OutingBelongingInput = { id, name };
      if (row.chargePercent.trim() !== "") {
        const charge = Number(row.chargePercent.trim());
        if (Number.isNaN(charge) || charge < 0 || charge > 100) {
          throw new Error(`「${name}」の充電%は 0〜100 です`);
        }
        item.chargePercent = charge;
      }
      belongings.push(item);
    } else {
      const title = row.title.trim();
      if (!title) continue;
      const id = row.id.trim() || slugFromName(title);
      if (!id) throw new Error(`「${title}」の id を確認してください`);
      const task: OutingTaskInput = { id, title };
      if (row.estimatedDurationSeconds.trim() !== "") {
        const dur = Number(row.estimatedDurationSeconds.trim());
        if (Number.isNaN(dur) || dur <= 0) {
          throw new Error(`「${title}」の所要秒は正の数です`);
        }
        task.estimatedDurationSeconds = dur;
      }
      if (row.notes.trim() !== "") task.notes = row.notes.trim();
      tasks.push(task);
    }
  }

  if (belongings.length === 0 && tasks.length === 0) {
    throw new Error("持ち物またはタスクを1つ以上追加してください");
  }

  const input: OutingInput = { departureAt, belongings, tasks };
  if (form.originLabel.trim() !== "") input.originLabel = form.originLabel.trim();
  if (form.destinationLabel.trim() !== "") {
    input.destinationLabel = form.destinationLabel.trim();
  }
  return input;
}
