import {
  parseOutingBelongingsFreeText,
  type OutingBelongingInput,
  type OutingInput,
} from "@pear-agent/outing-domain-example";

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

/**
 * Structure free text entered in the add-item modal into one or more belongings.
 * Uses Domain deterministic parser; returns null when LLM would be needed.
 */
export function structureBelongingFreeText(freeText: string): OutingBelongingInput[] | null {
  return parseOutingBelongingsFreeText(freeText);
}

export type AddBelongingModalDraft = {
  freeText: string;
  name: string;
  id: string;
  chargePercent: string;
};

/**
 * Resolve modal draft → structured rows.
 * Prefer free-text parse when freeText is non-empty; otherwise use structured fields.
 */
export function resolveBelongingModalDraft(draft: AddBelongingModalDraft): BelongingFormRow[] {
  const free = draft.freeText.trim();
  if (free) {
    const parsed = structureBelongingFreeText(free);
    if (!parsed || parsed.length === 0) {
      throw new Error(
        "自由文を構造化できませんでした。例:「Phone 30」や「phone:Phone:30」。または下の項目欄に直接入力してください。",
      );
    }
    return parsed.map(belongingInputToRow);
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
  const row = createEmptyBelongingRow({ id, name, chargePercent: chargeRaw });
  if (chargeRaw !== "") {
    const charge = Number(chargeRaw);
    if (Number.isNaN(charge) || charge < 0 || charge > 100) {
      throw new Error("充電%は 0〜100 で入力してください");
    }
  }
  return [row];
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
