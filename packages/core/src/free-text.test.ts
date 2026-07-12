import { describe, expect, it, vi } from "vitest";

import { freeTextValueSchema, isFreeTextValue, resolveMaybeFreeTextField } from "./free-text.js";

describe("freeTextValueSchema", () => {
  it("accepts non-empty free text", () => {
    expect(freeTextValueSchema.parse({ freeText: " tomorrow 10am " })).toEqual({
      freeText: "tomorrow 10am",
    });
  });

  it("rejects empty free text", () => {
    expect(freeTextValueSchema.safeParse({ freeText: "  " }).success).toBe(false);
  });
});

describe("resolveMaybeFreeTextField", () => {
  it("passes structured values through", async () => {
    await expect(
      resolveMaybeFreeTextField({
        domainId: "outing",
        field: "departureAt",
        value: "2026-07-12T01:00:00.000Z",
      }),
    ).resolves.toBe("2026-07-12T01:00:00.000Z");
  });

  it("uses deterministic parser before resolver", async () => {
    const resolve = vi.fn();
    await expect(
      resolveMaybeFreeTextField({
        domainId: "outing",
        field: "departureAt",
        value: { freeText: "2026-07-12T02:00:00.000Z" },
        freeTextResolver: { resolve },
        parseDeterministic: (text) => {
          const t = Date.parse(text);
          return Number.isNaN(t) ? null : new Date(t).toISOString();
        },
      }),
    ).resolves.toBe("2026-07-12T02:00:00.000Z");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("falls back to freeTextResolver when deterministic parse fails", async () => {
    await expect(
      resolveMaybeFreeTextField({
        domainId: "outing",
        field: "belongings",
        value: { freeText: "keys and phone at 30 percent" },
        freeTextResolver: {
          async resolve() {
            return [{ id: "keys", name: "Keys" }];
          },
        },
        parseDeterministic: () => null,
      }),
    ).resolves.toEqual([{ id: "keys", name: "Keys" }]);
  });

  it("throws when free text cannot be resolved", async () => {
    await expect(
      resolveMaybeFreeTextField({
        domainId: "outing",
        field: "belongings",
        value: { freeText: "???" },
        parseDeterministic: () => null,
      }),
    ).rejects.toThrow(/no freeTextResolver/);
  });

  it("detects free-text envelopes", () => {
    expect(isFreeTextValue({ freeText: "hi" })).toBe(true);
    expect(isFreeTextValue("hi")).toBe(false);
  });
});
