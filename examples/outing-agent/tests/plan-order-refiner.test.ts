import { describe, expect, it, vi, beforeEach } from "vitest";

import { buildOutingPlan, type OutingNormalizedInput } from "@pear-agent/outing-domain-example";

import { applyPlanStepOrder, refinePlanOrderWithGemini } from "../worker/src/plan-order-refiner.js";

vi.mock("../worker/src/gemini-json.js", () => ({
  generateGeminiJson: vi.fn(),
  GeminiServiceError: class GeminiServiceError extends Error {
    status: 400 | 502 | 503;
    constructor(message: string, status: 400 | 502 | 503 = 502) {
      super(message);
      this.name = "GeminiServiceError";
      this.status = status;
    }
  },
}));

import { generateGeminiJson } from "../worker/src/gemini-json.js";

const generateGeminiJsonMock = vi.mocked(generateGeminiJson);

const baseInput: OutingNormalizedInput = {
  departureAt: "2026-07-12T01:00:00.000Z",
  belongings: [
    { id: "keys", name: "Keys", chargePercent: null },
    { id: "phone", name: "Phone", chargePercent: 20 },
  ],
  tasks: [{ id: "weather", title: "Check weather", estimatedDurationSeconds: 30, notes: null }],
  originLabel: "Home",
  destinationLabel: "Office",
};

describe("applyPlanStepOrder", () => {
  it("rewires after edges without changing step bodies", () => {
    const base = buildOutingPlan(baseInput);
    expect(base.steps.every((s) => s.after.length === 0)).toBe(true);

    const ordered = applyPlanStepOrder(base, {
      steps: [
        { id: "pack", after: [] },
        { id: "charge", after: [] },
        { id: "task:weather", after: ["pack"] },
      ],
    });

    expect(ordered.steps.find((s) => s.id === "task:weather")?.after).toEqual(["pack"]);
    expect(ordered.steps.find((s) => s.id === "pack")?.domainData).toEqual(
      base.steps.find((s) => s.id === "pack")?.domainData,
    );
  });

  it("rejects cycles and unknown ids", () => {
    const base = buildOutingPlan(baseInput);
    expect(() =>
      applyPlanStepOrder(base, {
        steps: [
          { id: "pack", after: ["charge"] },
          { id: "charge", after: ["pack"] },
          { id: "task:weather", after: [] },
        ],
      }),
    ).toThrow(/cycle|Invalid plan graph/i);

    expect(() =>
      applyPlanStepOrder(base, {
        steps: [
          { id: "pack", after: [] },
          { id: "charge", after: [] },
          { id: "nope", after: [] },
        ],
      }),
    ).toThrow(/Unknown step id/);
  });
});

describe("refinePlanOrderWithGemini", () => {
  beforeEach(() => {
    generateGeminiJsonMock.mockReset();
  });

  it("returns base plan with no_api_key metadata when key missing", async () => {
    const base = buildOutingPlan(baseInput);
    const result = await refinePlanOrderWithGemini({
      apiKey: undefined,
      plan: base,
    });

    expect(result.refined).toBe(false);
    expect(result.reason).toBe("no_api_key");
    expect(result.plan.metadata?.orderRefined).toBe(false);
    expect(result.plan.metadata?.orderRefineReason).toBe("no_api_key");
    expect(result.plan.steps.every((s) => s.after.length === 0)).toBe(true);
    expect(generateGeminiJsonMock).not.toHaveBeenCalled();
  });

  it("applies Gemini order and sets orderRefined metadata", async () => {
    const base = buildOutingPlan(baseInput);
    generateGeminiJsonMock.mockResolvedValue({
      steps: [
        { id: "pack", after: [], reason: "start packing" },
        { id: "charge", after: [], reason: "parallel charge" },
        { id: "task:weather", after: ["pack"], reason: "after packed" },
      ],
    });

    const result = await refinePlanOrderWithGemini({
      apiKey: "test-key",
      plan: base,
    });

    expect(result.refined).toBe(true);
    expect(result.reason).toBe("gemini");
    expect(result.plan.metadata?.orderRefined).toBe(true);
    expect(result.plan.metadata?.orderRefineReason).toBe("gemini");
    expect(result.plan.metadata?.orderReasons).toMatchObject({
      "task:weather": "after packed",
    });
    expect(result.plan.steps.find((s) => s.id === "task:weather")?.after).toEqual(["pack"]);
    expect(generateGeminiJsonMock).toHaveBeenCalledOnce();
  });

  it("falls back on parse failure with metadata", async () => {
    const base = buildOutingPlan(baseInput);
    generateGeminiJsonMock.mockResolvedValue({ notSteps: true });

    const result = await refinePlanOrderWithGemini({
      apiKey: "test-key",
      plan: base,
    });

    expect(result.refined).toBe(false);
    expect(result.reason).toBe("parse_failed");
    expect(result.plan.metadata?.orderRefineReason).toBe("parse_failed");
    expect(result.plan.steps.every((s) => s.after.length === 0)).toBe(true);
  });

  it("falls back when order application fails (wrong step count)", async () => {
    const base = buildOutingPlan(baseInput);
    generateGeminiJsonMock.mockResolvedValue({ steps: [{ id: "only-one", after: [] }] });

    const result = await refinePlanOrderWithGemini({
      apiKey: "test-key",
      plan: base,
    });

    expect(result.refined).toBe(false);
    expect(result.reason).toMatch(/every step once/i);
    expect(result.plan.metadata?.orderRefined).toBe(false);
    expect(result.plan.steps.every((s) => s.after.length === 0)).toBe(true);
  });
});
