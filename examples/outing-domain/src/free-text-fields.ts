import { z } from "zod";

/**
 * Single registry for outing free-text fields: parse contract + Gemini hints.
 * Worker / UI resolve-field and Domain normalize should all key off this.
 */

export const OUTING_FREE_TEXT_FIELDS = [
  "departureAt",
  "belongings",
  "tasks",
  "originLabel",
  "destinationLabel",
] as const;

export type OutingFreeTextField = (typeof OUTING_FREE_TEXT_FIELDS)[number];

export function isOutingFreeTextField(field: string): field is OutingFreeTextField {
  return (OUTING_FREE_TEXT_FIELDS as readonly string[]).includes(field);
}

const belongingItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  chargePercent: z.number().min(0).max(100).optional(),
});

const taskItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  estimatedDurationSeconds: z.number().positive().optional(),
  notes: z.string().optional(),
});

export const outingFreeTextParse = {
  departureAt: (value: unknown): string => z.iso.datetime().parse(value),
  belongings: (value: unknown) => belongingItemSchema.array().parse(value),
  tasks: (value: unknown) => taskItemSchema.array().parse(value),
  originLabel: (value: unknown): string => z.string().trim().min(1).max(160).parse(value),
  destinationLabel: (value: unknown): string => z.string().trim().min(1).max(160).parse(value),
} as const satisfies Record<OutingFreeTextField, (value: unknown) => unknown>;

export const outingFreeTextHints: Record<OutingFreeTextField, string> = {
  departureAt: "ISO-8601 datetime string",
  belongings: "Array of { id, name, chargePercent? }",
  tasks: "Array of { id, title, estimatedDurationSeconds?, notes? }",
  originLabel: "Short place label, e.g. Shibuya Station",
  destinationLabel: "Short place label, e.g. Yokohama",
};

/** JSON Schema fragments for Gemini structured output (not Zod). */
export const outingFreeTextGeminiSchemas: Record<OutingFreeTextField, Record<string, unknown>> = {
  departureAt: {
    type: "object",
    properties: {
      departureAt: {
        type: "string",
        description: "ISO-8601 datetime with Z, e.g. 2026-07-12T10:00:00.000Z",
      },
    },
    required: ["departureAt"],
    additionalProperties: false,
  },
  belongings: {
    type: "object",
    properties: {
      belongings: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "kebab-case id" },
            name: { type: "string" },
            chargePercent: {
              type: "number",
              minimum: 0,
              maximum: 100,
              description: "battery % if device needs charge; omit otherwise",
            },
          },
          required: ["id", "name"],
          additionalProperties: false,
        },
      },
    },
    required: ["belongings"],
    additionalProperties: false,
  },
  tasks: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "kebab-case id" },
            title: { type: "string" },
            estimatedDurationSeconds: {
              type: "number",
              minimum: 1,
              description: "optional estimate in seconds",
            },
            notes: { type: "string" },
          },
          required: ["id", "title"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  originLabel: {
    type: "object",
    properties: {
      label: { type: "string", description: "Short place name" },
    },
    required: ["label"],
    additionalProperties: false,
  },
  destinationLabel: {
    type: "object",
    properties: {
      label: { type: "string", description: "Short place name" },
    },
    required: ["label"],
    additionalProperties: false,
  },
};

/**
 * Normalize Gemini raw object into the value Domain `parse` expects
 * (unwrap { departureAt } / { belongings } / { label } envelopes).
 */
export function unwrapOutingFreeTextGeminiResult(
  field: OutingFreeTextField,
  raw: unknown,
): unknown {
  if (field === "departureAt") {
    if (raw && typeof raw === "object" && "departureAt" in raw) {
      return (raw as { departureAt: unknown }).departureAt;
    }
    return raw;
  }
  if (field === "belongings") {
    if (raw && typeof raw === "object" && "belongings" in raw) {
      return (raw as { belongings: unknown }).belongings;
    }
    return raw;
  }
  if (field === "tasks") {
    if (raw && typeof raw === "object" && "tasks" in raw) {
      return (raw as { tasks: unknown }).tasks;
    }
    return raw;
  }
  // origin / destination
  if (raw && typeof raw === "object" && "label" in raw) {
    return (raw as { label: unknown }).label;
  }
  return raw;
}
