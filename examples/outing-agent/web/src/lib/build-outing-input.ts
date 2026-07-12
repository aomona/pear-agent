import type { OutingInput } from "@pear-agent/outing-domain-example";

/** One belongings row in the input form (one item = one set of fields). */
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
  /** `items` = per-item fields; `freeText` = single natural-language box for all. */
  belongingsMode: "items" | "freeText";
  departureLocal: string;
  departureFreeText: string;
  belongings: BelongingFormRow[];
  belongingsFreeText: string;
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

export function defaultBelongingRows(): BelongingFormRow[] {
  return [
    createEmptyBelongingRow({ id: "keys", name: "Keys", chargePercent: "" }),
    createEmptyBelongingRow({ id: "phone", name: "Phone", chargePercent: "20" }),
    createEmptyBelongingRow({ id: "wallet", name: "Wallet", chargePercent: "" }),
  ];
}

/** Derive a stable slug id from a display name when id is left blank. */
export function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build Domain input (structured or free-text envelopes) from the setup form. */
export function buildOutingInputFromForm(form: OutingFormState): OutingInput {
  const departureAt: OutingInput["departureAt"] =
    form.departureMode === "freeText"
      ? { freeText: form.departureFreeText.trim() }
      : new Date(form.departureLocal).toISOString();

  if (form.departureMode === "freeText" && !form.departureFreeText.trim()) {
    throw new Error("出発時刻の自由文を入力してください");
  }

  let belongings: OutingInput["belongings"];
  if (form.belongingsMode === "freeText") {
    const text = form.belongingsFreeText.trim();
    if (!text) throw new Error("持ち物の自由文を入力してください");
    belongings = { freeText: text };
  } else {
    const rows = form.belongings
      .map((row) => ({
        name: row.name.trim(),
        id: row.id.trim() || slugFromName(row.name),
        chargeRaw: row.chargePercent.trim(),
      }))
      .filter((row) => row.name.length > 0);

    if (rows.length === 0) {
      throw new Error("持ち物を1つ以上入力してください");
    }

    belongings = rows.map((row) => {
      if (!row.id) {
        throw new Error(
          `「${row.name}」の id を入力するか、名前から生成できる文字列にしてください`,
        );
      }
      const item: Extract<OutingInput["belongings"], unknown[]>[number] = {
        id: row.id,
        name: row.name,
      };
      if (row.chargeRaw !== "") {
        const charge = Number(row.chargeRaw);
        if (Number.isNaN(charge) || charge < 0 || charge > 100) {
          throw new Error(`「${row.name}」の充電%は 0〜100 で入力してください`);
        }
        item.chargePercent = charge;
      }
      return item;
    });
  }

  return { departureAt, belongings };
}
