import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  capabilityDefinitionSchema,
  defineDomain,
  executionDomainDefinitionSchema,
} from "./index.js";

const schemas = {
  input: z.object({ departureAt: z.iso.datetime() }),
  normalizedInput: z.object({ departureAt: z.iso.datetime(), items: z.array(z.string()) }),
  stepData: z.object({ itemIds: z.array(z.string()) }),
  worldState: z.object({ packedItemIds: z.array(z.string()) }),
  events: z.discriminatedUnion("type", [
    z.object({ type: z.literal("delay"), minutes: z.number().positive() }),
  ]),
};

const validDefinition = () => ({
  id: "outing",
  version: 1,
  schemas,
  normalizeInput: async (input: z.output<typeof schemas.input>) => ({ ...input, items: [] }),
  planning: { instructions: "Plan the outing", objectives: ["Leave on time"] as const },
  replanning: { instructions: "Replan affected work", defaultMode: "automatic" as const },
  capabilities: [],
  completionPolicy: "automatic" as const,
});

describe("defineDomain", () => {
  it("preserves the domain definition and its inferred schema types", async () => {
    const domain = defineDomain({
      id: "outing",
      version: 1,
      schemas: {
        input: z.object({ departureAt: z.iso.datetime() }),
        normalizedInput: z.object({ departureAt: z.iso.datetime(), items: z.array(z.string()) }),
        stepData: z.object({ itemIds: z.array(z.string()) }),
        worldState: z.object({ packedItemIds: z.array(z.string()) }),
        events: z.discriminatedUnion("type", [
          z.object({ type: z.literal("delay"), minutes: z.number().positive() }),
        ]),
      },
      normalizeInput: async (input) => ({ ...input, items: [] }),
      planning: { instructions: "出発準備を計画する", objectives: ["期限を守る"] },
      replanning: { instructions: "影響範囲だけを更新する", defaultMode: "automatic" },
      capabilities: [],
      completionPolicy: "automatic",
    });

    expect(domain.id).toBe("outing");
    expectTypeOf(domain.id).toEqualTypeOf<"outing">();
    expectTypeOf(domain.version).toEqualTypeOf<1>();
    await expect(domain.normalizeInput({ departureAt: "2026-07-11T03:00:00Z" })).resolves.toEqual({
      departureAt: "2026-07-11T03:00:00Z",
      items: [],
    });
  });

  it("rejects normalized input that does not match its schema", async () => {
    const domain = defineDomain({
      id: "invalid-normalizer",
      version: 1,
      schemas: {
        input: z.object({ departureAt: z.iso.datetime() }),
        normalizedInput: z.object({ departureAt: z.iso.datetime(), items: z.array(z.string()) }),
        stepData: z.object({}),
        worldState: z.object({}),
        events: z.never(),
      },
      normalizeInput: async (input) => ({ ...input, items: undefined }) as never,
      planning: { instructions: "Plan", objectives: ["Leave on time"] },
      replanning: { instructions: "Replan", defaultMode: "automatic" },
      capabilities: [],
      completionPolicy: "automatic",
    });

    await expect(domain.normalizeInput({ departureAt: "2026-07-11T03:00:00Z" })).rejects.toThrow();
  });

  it("rejects a domain without planning objectives", () => {
    expect(() =>
      defineDomain({
        id: "no-objectives",
        version: 1,
        schemas: {
          input: z.object({}),
          normalizedInput: z.object({}),
          stepData: z.object({}),
          worldState: z.object({}),
          events: z.never(),
        },
        normalizeInput: async (input) => input,
        planning: { instructions: "Plan", objectives: [] as never },
        replanning: { instructions: "Replan", defaultMode: "automatic" },
        capabilities: [],
        completionPolicy: "automatic",
      }),
    ).toThrow("Domain planning objectives must not be empty");
  });

  it.each([
    ["empty id", { id: "" }],
    ["non-positive version", { version: 0 }],
    ["empty planning instructions", { planning: { instructions: "", objectives: ["Goal"] } }],
    [
      "empty replanning instructions",
      { replanning: { instructions: "", defaultMode: "automatic" } },
    ],
    ["empty objective", { planning: { instructions: "Plan", objectives: [""] } }],
  ])("rejects %s", (_name, override) => {
    expect(() => defineDomain({ ...validDefinition(), ...override } as never)).toThrow();
  });

  it("rejects an invalid capability", () => {
    const inputSchema = z.object({ value: z.string() });
    const outputSchema = z.object({ ok: z.boolean() });
    expect(() =>
      defineDomain({
        ...validDefinition(),
        capabilities: [
          {
            id: "",
            description: "Run action",
            inputSchema,
            outputSchema,
            executionMode: "automatic",
            riskLevel: "low",
            execute: async () => ({ ok: true }),
          },
        ],
      }),
    ).toThrow();
  });

  it("exposes a schema factory that preserves supplied schema identity", () => {
    const capabilityInput = z.object({ value: z.string() });
    const capabilityOutput = z.object({ ok: z.boolean() });
    const capabilitySchema = capabilityDefinitionSchema(capabilityInput, capabilityOutput);
    const schema = executionDomainDefinitionSchema(schemas, [capabilitySchema] as const);
    const definition = {
      ...validDefinition(),
      capabilities: [
        {
          id: "run",
          description: "Run action",
          inputSchema: capabilityInput,
          outputSchema: capabilityOutput,
          executionMode: "automatic" as const,
          riskLevel: "low" as const,
          execute: async () => ({ ok: true }),
        },
      ] as const,
    };

    const parsed = schema.parse(definition);
    expect(parsed.schemas.input).toBe(schemas.input);
    expect(parsed.capabilities[0]?.inputSchema).toBe(capabilityInput);
    const inferredInputSchema: typeof schemas.input = parsed.schemas.input;
    expect(inferredInputSchema).toBe(schemas.input);
  });

  it("rejects a schemas object with unexpected keys", () => {
    const schema = executionDomainDefinitionSchema(schemas, [] as const);
    const definition = {
      ...validDefinition(),
      schemas: { ...schemas, extra: z.object({}) },
    };

    expect(schema.safeParse(definition).success).toBe(false);
  });
});
