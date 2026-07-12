import type { OutingInput } from "@pear-agent/outing-domain-example";

export type OutingFormState = {
  departureMode: "structured" | "freeText";
  belongingsMode: "structured" | "freeText";
  departureLocal: string;
  departureFreeText: string;
  belongingsText: string;
  belongingsFreeText: string;
};

export function defaultDepartureLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Build Domain input (structured or free-text envelopes) from the setup form. */
export function buildOutingInputFromForm(form: OutingFormState): OutingInput {
  const departureAt: OutingInput["departureAt"] =
    form.departureMode === "freeText"
      ? { freeText: form.departureFreeText }
      : new Date(form.departureLocal).toISOString();

  let belongings: OutingInput["belongings"];
  if (form.belongingsMode === "freeText") {
    belongings = { freeText: form.belongingsFreeText };
  } else {
    belongings = form.belongingsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, name, charge] = line.split(":").map((s) => s.trim());
        if (!id || !name) throw new Error(`Invalid belonging line: ${line}`);
        const item: Extract<OutingInput["belongings"], unknown[]>[number] = { id, name };
        if (charge !== undefined && charge !== "") {
          item.chargePercent = Number(charge);
        }
        return item;
      });
    if (belongings.length === 0) throw new Error("Add at least one belonging");
  }

  return { departureAt, belongings };
}
