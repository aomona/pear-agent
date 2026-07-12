import { describe, expect, it } from "vitest";

import {
  belongingServerValueToRows,
  buildOutingInputFromForm,
  createEmptyBelongingRow,
  createPendingBelongingRow,
  defaultDepartureLocal,
  hasInFlightBelongings,
  resolveBelongingModalDraftLocal,
  slugFromName,
} from "../web/src/lib/build-outing-input.js";

describe("resolveBelongingModalDraftLocal", () => {
  it("routes free text to Gemini (no local structure)", () => {
    expect(
      resolveBelongingModalDraftLocal({
        freeText: "phone:Phone:20",
        name: "",
        id: "",
        chargePercent: "",
      }),
    ).toEqual({ kind: "needs_gemini", freeText: "phone:Phone:20" });
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
      expect(result.rows[0]).toMatchObject({
        status: "ready",
        id: "wallet",
        name: "Wallet",
      });
    }
  });
});

describe("pending optimistic rows", () => {
  it("creates pending row for free text preview", () => {
    const pending = createPendingBelongingRow("スマホ 30%");
    expect(pending.status).toBe("pending");
    expect(pending.freeTextPreview).toBe("スマホ 30%");
    expect(hasInFlightBelongings([pending])).toBe(true);
  });

  it("blocks normalize while pending", () => {
    expect(() =>
      buildOutingInputFromForm({
        departureMode: "structured",
        departureLocal: "2026-07-12T10:00",
        departureFreeText: "",
        belongings: [createPendingBelongingRow("phone")],
      }),
    ).toThrow(/構造化中/);
  });
});

describe("belongingServerValueToRows", () => {
  it("maps server JSON to ready form rows", () => {
    const rows = belongingServerValueToRows([{ id: "keys", name: "Keys" }]);
    expect(rows[0]).toMatchObject({
      status: "ready",
      id: "keys",
      name: "Keys",
      chargePercent: "",
    });
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
