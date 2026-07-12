import { describe, expect, it } from "vitest";

import {
  belongingServerValueToRows,
  buildOutingInputFromForm,
  createEmptyBelongingRow,
  defaultDepartureLocal,
  resolveBelongingModalDraftLocal,
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

describe("resolveBelongingModalDraftLocal", () => {
  it("structures free text locally when deterministic", () => {
    const result = resolveBelongingModalDraftLocal({
      freeText: "phone:Phone:20",
      name: "",
      id: "",
      chargePercent: "",
    });
    expect(result.kind).toBe("structured");
    if (result.kind === "structured") {
      expect(result.rows[0]).toMatchObject({ id: "phone", name: "Phone", chargePercent: "20" });
    }
  });

  it("defers ambiguous free text to server (structure on Add only)", () => {
    const result = resolveBelongingModalDraftLocal({
      freeText: "whatever i usually take when leaving home in the morning",
      name: "",
      id: "",
      chargePercent: "",
    });
    expect(result).toEqual({
      kind: "needs_server",
      freeText: "whatever i usually take when leaving home in the morning",
    });
  });

  it("uses structured fields when free text empty", () => {
    const result = resolveBelongingModalDraftLocal({
      freeText: "",
      name: "Wallet",
      id: "",
      chargePercent: "",
    });
    expect(result.kind).toBe("structured");
    if (result.kind === "structured") {
      expect(result.rows[0]).toMatchObject({ id: "wallet", name: "Wallet" });
    }
  });
});

describe("belongingServerValueToRows", () => {
  it("maps server JSON to form rows", () => {
    const rows = belongingServerValueToRows([{ id: "keys", name: "Keys" }]);
    expect(rows[0]).toMatchObject({ id: "keys", name: "Keys", chargePercent: "" });
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
