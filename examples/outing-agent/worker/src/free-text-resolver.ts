import type { FreeTextFieldResolver } from "@pear-agent/core";
import { z } from "zod";

import { generateGeminiJson, GeminiServiceError } from "./gemini-json.js";

const departureSchema = {
  type: "object",
  properties: {
    departureAt: {
      type: "string",
      description: "ISO-8601 datetime with offset or Z, e.g. 2026-07-12T10:00:00.000Z",
    },
  },
  required: ["departureAt"],
  additionalProperties: false,
} as const;

const belongingsSchema = {
  type: "object",
  properties: {
    belongings: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "slug id, e.g. phone" },
          name: { type: "string", description: "display name" },
          chargePercent: {
            type: "number",
            minimum: 0,
            maximum: 100,
            description: "Current battery % when the item needs charging; omit if N/A",
          },
        },
        required: ["id", "name"],
        additionalProperties: false,
      },
    },
  },
  required: ["belongings"],
  additionalProperties: false,
} as const;

const departureResultSchema = z.object({
  departureAt: z.string().min(1),
});

const belongingsResultSchema = z.object({
  belongings: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        chargePercent: z.number().min(0).max(100).optional(),
      }),
    )
    .min(1),
});

export type CreateGeminiFreeTextResolverOptions = {
  getApiKey: () => string | undefined;
  /** Optional clock for relative phrases like "tomorrow morning". */
  now?: () => Date;
  model?: string;
};

/**
 * Host FreeTextFieldResolver for outing Domain fields via Gemini structured output.
 * Deterministic parsers run first in Domain normalize; this is the LLM fallback.
 */
export function createGeminiFreeTextResolver(
  options: CreateGeminiFreeTextResolverOptions,
): FreeTextFieldResolver {
  return {
    async resolve(input) {
      const now = options.now?.() ?? new Date();
      const system = [
        "You convert natural-language outing-prep fields into strict JSON.",
        "Do not invent unrelated items. Prefer concrete ids (kebab-case).",
        `Reference now (UTC): ${now.toISOString()}`,
        "If the user says relative times (tomorrow morning), resolve against now.",
      ].join("\n");

      if (input.field === "departureAt") {
        const raw = await generateGeminiJson({
          apiKey: options.getApiKey(),
          ...(options.model !== undefined ? { model: options.model } : {}),
          system,
          user: [
            "Extract departure datetime.",
            input.hint ? `Hint: ${input.hint}` : "",
            `Free text: ${input.freeText}`,
          ]
            .filter(Boolean)
            .join("\n"),
          schema: departureSchema as unknown as Record<string, unknown>,
        });
        const parsed = departureResultSchema.safeParse(raw);
        if (!parsed.success) {
          throw new GeminiServiceError(
            `Could not resolve departureAt free text: ${parsed.error.message}`,
            400,
          );
        }
        // Domain parse expects ISO string; allow Date.parse-able values.
        const ms = Date.parse(parsed.data.departureAt);
        if (Number.isNaN(ms)) {
          throw new GeminiServiceError(
            `Resolved departureAt is not a valid datetime: ${parsed.data.departureAt}`,
            400,
          );
        }
        return new Date(ms).toISOString();
      }

      if (input.field === "belongings") {
        const raw = await generateGeminiJson({
          apiKey: options.getApiKey(),
          ...(options.model !== undefined ? { model: options.model } : {}),
          system,
          user: [
            "Extract belongings for leaving the house.",
            "Items that need charging should include chargePercent (0-100).",
            input.hint ? `Hint: ${input.hint}` : "",
            `Free text: ${input.freeText}`,
          ]
            .filter(Boolean)
            .join("\n"),
          schema: belongingsSchema as unknown as Record<string, unknown>,
        });
        const parsed = belongingsResultSchema.safeParse(raw);
        if (!parsed.success) {
          throw new GeminiServiceError(
            `Could not resolve belongings free text: ${parsed.error.message}`,
            400,
          );
        }
        return parsed.data.belongings;
      }

      throw new GeminiServiceError(`No Gemini free-text schema for field "${input.field}"`, 400);
    },
  };
}
