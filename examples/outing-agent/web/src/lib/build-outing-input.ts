import type { OutingBelongingInput, OutingInput } from "@pear-agent/outing-domain-example";
import { z } from "zod";

/** One belongings row already structured in the list. */
export type BelongingFormRow = {
  /** Stable React key (not sent to Domain). */
  key: string;
  id: string;
  name: string;
  /** Empty string = no charge requirement. */
  chargePercent: string;
};

export type OutingFormState = {
  departureMode: "structured" | "freeText";
  departureLocal: string;
  departureFreeText: string;
  /** Always structured rows (added one-by-one via modal). */
  belongings: BelongingFormRow[];
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

export function createEmptyBelongingRow(
  partial?: Partial<Omit<BelongingFormRow, "key">>,
): BelongingFormRow {
  return {
    key: newRowKey(),
    id: partial?.id ?? "",
    name: partial?.name ?? "",
    chargePercent: partial?.chargePercent ?? "",
  };
}

export function belongingInputToRow(item: OutingBelongingInput): BelongingFormRow {
  return createEmptyBelongingRow({
    id: item.id,
    name: item.name,
    chargePercent:
      item.chargePercent === undefined || item.chargePercent === null
        ? ""
        : String(item.chargePercent),
  });
}

/** Derive a stable slug id from a display name when id is left blank. */
export function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export type AddBelongingModalDraft = {
  freeText: string;
  name: string;
  id: string;
  chargePercent: string;
};

export type BelongingModalLocalResult =
  /** Free text always structured via Gemini on the Worker (never client deterministic). */
  { kind: "needs_gemini"; freeText: string } | { kind: "structured"; rows: BelongingFormRow[] };

/**
 * Classify modal draft at Add time (no free-text parsing here).
 * Free text → always Gemini on the server. Direct fields → structured rows.
 */
export function resolveBelongingModalDraftLocal(
  draft: AddBelongingModalDraft,
): BelongingModalLocalResult {
  const free = draft.freeText.trim();
  if (free) {
    return { kind: "needs_gemini", freeText: free };
  }

  const name = draft.name.trim();
  if (!name) {
    throw new Error("自由文か、名前を入力してください");
  }
  const id = draft.id.trim() || slugFromName(name);
  if (!id) {
    throw new Error("id を入力するか、名前から生成できる文字列にしてください");
  }
  const chargeRaw = draft.chargePercent.trim();
  if (chargeRaw !== "") {
    const charge = Number(chargeRaw);
    if (Number.isNaN(charge) || charge < 0 || charge > 100) {
      throw new Error("充電%は 0〜100 で入力してください");
    }
  }
  return {
    kind: "structured",
    rows: [createEmptyBelongingRow({ id, name, chargePercent: chargeRaw })],
  };
}

/** Map server resolve-field value for belongings into form rows. */
export function belongingServerValueToRows(value: unknown): BelongingFormRow[] {
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
    belongingInputToRow({
      id: item.id,
      name: item.name,
      ...(item.chargePercent !== undefined ? { chargePercent: item.chargePercent } : {}),
    }),
  );
}

/** Build Domain input from the multi-field form (belongings always structured). */
export function buildOutingInputFromForm(form: OutingFormState): OutingInput {
  const departureAt: OutingInput["departureAt"] =
    form.departureMode === "freeText"
      ? { freeText: form.departureFreeText.trim() }
      : new Date(form.departureLocal).toISOString();

  if (form.departureMode === "freeText" && !form.departureFreeText.trim()) {
    throw new Error("出発時刻の自由文を入力してください");
  }

  const rows = form.belongings
    .map((row) => ({
      name: row.name.trim(),
      id: row.id.trim() || slugFromName(row.name),
      chargeRaw: row.chargePercent.trim(),
    }))
    .filter((row) => row.name.length > 0);

  if (rows.length === 0) {
    throw new Error("持ち物を1つ以上追加してください");
  }

  const belongings = rows.map((row) => {
    if (!row.id) {
      throw new Error(`「${row.name}」の id を確認してください`);
    }
    const item: OutingBelongingInput = { id: row.id, name: row.name };
    if (row.chargeRaw !== "") {
      const charge = Number(row.chargeRaw);
      if (Number.isNaN(charge) || charge < 0 || charge > 100) {
        throw new Error(`「${row.name}」の充電%は 0〜100 です`);
      }
      item.chargePercent = charge;
    }
    return item;
  });

  return { departureAt, belongings };
}
