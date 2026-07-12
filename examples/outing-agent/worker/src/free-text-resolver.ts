import type { FreeTextFieldResolver } from "@pear-agent/core";
import { z } from "zod";

import { generateGeminiJson, GeminiServiceError } from "./gemini-json.js";

const departureSchema = {
  type: "object",
  properties: {
    departureAt: {
      type: "string",
      description: "ISO-8601 datetime with Z, e.g. 2026-07-12T10:00:00.000Z",
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
  now?: () => Date;
  model?: string;
};

/**
 * Fast free-text → structured JSON via Gemini flash-lite (no reasoning).
 */
export function createGeminiFreeTextResolver(
  options: CreateGeminiFreeTextResolverOptions,
): FreeTextFieldResolver {
  return {
    async resolve(input) {
      const now = options.now?.() ?? new Date();

      if (input.field === "departureAt") {
        const raw = await generateGeminiJson({
          apiKey: options.getApiKey(),
          ...(options.model !== undefined ? { model: options.model } : {}),
          system: `Extract one departure datetime as ISO-8601 UTC. Now=${now.toISOString()}. JSON only.`,
          user: input.freeText,
          schema: departureSchema as unknown as Record<string, unknown>,
          maxOutputTokens: 128,
        });
        const parsed = departureResultSchema.safeParse(raw);
        if (!parsed.success) {
          throw new GeminiServiceError(
            `Could not resolve departureAt free text: ${parsed.error.message}`,
            400,
          );
        }
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
          system:
            "Extract leave-home items as JSON. kebab-case ids. chargePercent only for devices. No extra items.",
          user: input.freeText,
          schema: belongingsSchema as unknown as Record<string, unknown>,
          maxOutputTokens: 384,
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
