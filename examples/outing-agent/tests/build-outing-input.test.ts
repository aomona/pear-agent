import { describe, expect, it } from "vitest";

import {
  belongingServerValueToRows,
  buildOutingInputFromForm,
  createEmptyBelongingRow,
  createEmptyTaskRow,
  createPendingRow,
  defaultDepartureLocal,
  formStateFromNormalized,
  hasInFlightItems,
  resolveAddPrepModalLocal,
  taskServerValueToRows,
} from "../web/src/lib/build-outing-input.js";

describe("resolveAddPrepModalLocal", () => {
  it("routes free text to Gemini for belongings and tasks", () => {
    expect(
      resolveAddPrepModalLocal({
        kind: "belonging",
        freeText: "phone 20",
        name: "",
        id: "",
        chargePercent: "",
        title: "",
        taskId: "",
        estimatedDurationSeconds: "",
        notes: "",
      }),
    ).toEqual({ kind: "needs_gemini", itemKind: "belonging", freeText: "phone 20" });
  });

  it("structures direct task fields", () => {
    const result = resolveAddPrepModalLocal({
      kind: "task",
      freeText: "",
      name: "",
      id: "",
      chargePercent: "",
      title: "Check weather",
      taskId: "",
      estimatedDurationSeconds: "45",
      notes: "App",
    });
    expect(result.kind).toBe("structured");
    if (result.kind === "structured") {
      expect(result.rows[0]).toMatchObject({
        kind: "task",
        status: "ready",
        title: "Check weather",
        id: "check-weather",
        estimatedDurationSeconds: "45",
        notes: "App",
      });
    }
  });
});

describe("buildOutingInputFromForm", () => {
  it("includes belongings, tasks, and places", () => {
    const input = buildOutingInputFromForm({
      departureMode: "structured",
      departureLocal: "2026-07-12T10:00",
      departureFreeText: "",
      originLabel: "Home",
      destinationLabel: "Office",
      items: [
        createEmptyBelongingRow({ id: "keys", name: "Keys", chargePercent: "" }),
        createEmptyTaskRow({
          id: "lock",
          title: "Lock door",
          estimatedDurationSeconds: "30",
          notes: "",
        }),
      ],
    });
    expect(input.originLabel).toBe("Home");
    expect(input.destinationLabel).toBe("Office");
    expect(input.belongings).toEqual([{ id: "keys", name: "Keys" }]);
    expect(input.tasks).toEqual([{ id: "lock", title: "Lock door", estimatedDurationSeconds: 30 }]);
  });

  it("allows task-only input", () => {
    const input = buildOutingInputFromForm({
      departureMode: "structured",
      departureLocal: "2026-07-12T10:00",
      departureFreeText: "",
      originLabel: "",
      destinationLabel: "",
      items: [createEmptyTaskRow({ id: "shoes", title: "Shoes", estimatedDurationSeconds: "" })],
    });
    expect(input.belongings).toEqual([]);
    expect(input.tasks).toEqual([{ id: "shoes", title: "Shoes" }]);
  });

  it("blocks normalize while pending", () => {
    expect(() =>
      buildOutingInputFromForm({
        departureMode: "structured",
        departureLocal: "2026-07-12T10:00",
        departureFreeText: "",
        originLabel: "",
        destinationLabel: "",
        items: [createPendingRow("task", "something")],
      }),
    ).toThrow(/構造化中/);
    expect(hasInFlightItems([createPendingRow("belonging", "x")])).toBe(true);
  });

  it("uses free-text departure", () => {
    const input = buildOutingInputFromForm({
      departureMode: "freeText",
      departureLocal: defaultDepartureLocal(),
      departureFreeText: "tomorrow 10am",
      originLabel: "",
      destinationLabel: "",
      items: [createEmptyBelongingRow({ id: "keys", name: "Keys" })],
    });
    expect(input.departureAt).toEqual({ freeText: "tomorrow 10am" });
  });
});

describe("server value mappers", () => {
  it("maps belongings and tasks", () => {
    expect(belongingServerValueToRows([{ id: "k", name: "Keys" }])[0]).toMatchObject({
      kind: "belonging",
      id: "k",
    });
    expect(taskServerValueToRows([{ id: "t", title: "Todo" }])[0]).toMatchObject({
      kind: "task",
      title: "Todo",
    });
  });
});

describe("formStateFromNormalized", () => {
  it("hydrates structured form fields from saved input", () => {
    const form = formStateFromNormalized({
      departureAt: "2026-07-12T01:00:00.000Z",
      belongings: [{ id: "keys", name: "Keys", chargePercent: null }],
      tasks: [{ id: "weather", title: "Check weather", estimatedDurationSeconds: 30, notes: null }],
      originLabel: "Home",
      destinationLabel: "Office",
    });
    expect(form.departureMode).toBe("structured");
    expect(form.originLabel).toBe("Home");
    expect(form.destinationLabel).toBe("Office");
    expect(form.items).toHaveLength(2);
    expect(form.items[0]).toMatchObject({ kind: "belonging", id: "keys", status: "ready" });
    expect(form.items[1]).toMatchObject({ kind: "task", id: "weather", status: "ready" });
  });
});
