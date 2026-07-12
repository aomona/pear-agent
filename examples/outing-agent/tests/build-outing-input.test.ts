import { describe, expect, it } from "vitest";

import {
  buildOutingInputFromForm,
  createEmptyBelongingRow,
  defaultDepartureLocal,
  slugFromName,
} from "../web/src/lib/build-outing-input.js";

describe("buildOutingInputFromForm", () => {
  it("builds structured departure and per-item belongings", () => {
    const input = buildOutingInputFromForm({
      departureMode: "structured",
      belongingsMode: "items",
      departureLocal: "2026-07-12T10:00",
      departureFreeText: "",
      belongings: [
        createEmptyBelongingRow({ id: "keys", name: "Keys", chargePercent: "" }),
        createEmptyBelongingRow({ id: "phone", name: "Phone", chargePercent: "20" }),
      ],
      belongingsFreeText: "",
    });

    expect(input.departureAt).toMatch(/2026-07-12T/);
    expect(input.belongings).toEqual([
      { id: "keys", name: "Keys" },
      { id: "phone", name: "Phone", chargePercent: 20 },
    ]);
  });

  it("uses free-text envelopes when selected", () => {
    const input = buildOutingInputFromForm({
      departureMode: "freeText",
      belongingsMode: "freeText",
      departureLocal: defaultDepartureLocal(),
      departureFreeText: "tomorrow 10am",
      belongings: [createEmptyBelongingRow()],
      belongingsFreeText: "wallet and keys",
    });
    expect(input).toEqual({
      departureAt: { freeText: "tomorrow 10am" },
      belongings: { freeText: "wallet and keys" },
    });
  });

  it("derives id from name when blank", () => {
    expect(slugFromName("My Phone")).toBe("my-phone");
    const input = buildOutingInputFromForm({
      departureMode: "structured",
      belongingsMode: "items",
      departureLocal: "2026-07-12T10:00",
      departureFreeText: "",
      belongings: [createEmptyBelongingRow({ id: "", name: "Wallet", chargePercent: "" })],
      belongingsFreeText: "",
    });
    expect(input.belongings).toEqual([{ id: "wallet", name: "Wallet" }]);
  });
});
