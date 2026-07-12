import { describe, expect, it } from "vitest";

import {
  buildOutingInputFromForm,
  createEmptyBelongingRow,
  defaultDepartureLocal,
  resolveBelongingModalDraft,
  slugFromName,
  structureBelongingFreeText,
} from "../web/src/lib/build-outing-input.js";

describe("structureBelongingFreeText", () => {
  it("parses a single free-text item", () => {
    expect(structureBelongingFreeText("Phone 30")).toEqual([
      { id: "phone", name: "Phone", chargePercent: 30 },
    ]);
  });
});

describe("resolveBelongingModalDraft", () => {
  it("structures free text into rows", () => {
    const rows = resolveBelongingModalDraft({
      freeText: "phone:Phone:20",
      name: "",
      id: "",
      chargePercent: "",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "phone", name: "Phone", chargePercent: "20" });
  });

  it("uses structured fields when free text empty", () => {
    const rows = resolveBelongingModalDraft({
      freeText: "",
      name: "Wallet",
      id: "",
      chargePercent: "",
    });
    expect(rows[0]).toMatchObject({ id: "wallet", name: "Wallet", chargePercent: "" });
  });

  it("throws when free text cannot be structured", () => {
    expect(() =>
      resolveBelongingModalDraft({
        freeText: "whatever i usually take when leaving home in the morning",
        name: "",
        id: "",
        chargePercent: "",
      }),
    ).toThrow(/構造化できませんでした/);
  });
});

describe("buildOutingInputFromForm", () => {
  it("builds structured departure and belonging rows", () => {
    const input = buildOutingInputFromForm({
      departureMode: "structured",
      departureLocal: "2026-07-12T10:00",
      departureFreeText: "",
      belongings: [
        createEmptyBelongingRow({ id: "keys", name: "Keys", chargePercent: "" }),
        createEmptyBelongingRow({ id: "phone", name: "Phone", chargePercent: "20" }),
      ],
    });

    expect(input.departureAt).toMatch(/2026-07-12T/);
    expect(input.belongings).toEqual([
      { id: "keys", name: "Keys" },
      { id: "phone", name: "Phone", chargePercent: 20 },
    ]);
  });

  it("uses free-text departure envelope", () => {
    const input = buildOutingInputFromForm({
      departureMode: "freeText",
      departureLocal: defaultDepartureLocal(),
      departureFreeText: "tomorrow 10am",
      belongings: [createEmptyBelongingRow({ id: "keys", name: "Keys", chargePercent: "" })],
    });
    expect(input.departureAt).toEqual({ freeText: "tomorrow 10am" });
  });

  it("derives id from name", () => {
    expect(slugFromName("My Phone")).toBe("my-phone");
  });
});
