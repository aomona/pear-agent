import type { FreeTextFieldResolver } from "@pear-agent/core";
import {
  isOutingFreeTextField,
  outingFreeTextGeminiSchemas,
  outingFreeTextParse,
  unwrapOutingFreeTextGeminiResult,
  type OutingFreeTextField,
} from "@pear-agent/outing-domain-example";

import { generateGeminiJson, GeminiServiceError } from "./gemini-json.js";

const maxTokensByField: Record<OutingFreeTextField, number> = {
  departureAt: 128,
  belongings: 384,
  tasks: 384,
  originLabel: 64,
  destinationLabel: 64,
};

const systemByField = (field: OutingFreeTextField, nowIso: string): string => {
  switch (field) {
    case "departureAt":
      return `Extract one departure datetime as ISO-8601 UTC. Now=${nowIso}. JSON only.`;
    case "belongings":
      return "Extract leave-home items as JSON. kebab-case ids. chargePercent only for devices.";
    case "tasks":
      return "Extract prep tasks before leaving as JSON. kebab-case ids. Optional duration seconds.";
    case "originLabel":
    case "destinationLabel":
      return "Extract a short place label (city, station, or venue). JSON only.";
  }
};

export type CreateGeminiFreeTextResolverOptions = {
  getApiKey: () => string | undefined;
  now?: () => Date;
  model?: string;
};

/**
 * Free-text → structured via Gemini flash-lite. Field contracts come from
 * outing-domain free-text registry (single source of truth).
 */
export function createGeminiFreeTextResolver(
  options: CreateGeminiFreeTextResolverOptions,
): FreeTextFieldResolver {
  return {
    async resolve(input) {
      if (!isOutingFreeTextField(input.field)) {
        throw new GeminiServiceError(`No Gemini free-text schema for field "${input.field}"`, 400);
      }
      const field = input.field;
      const now = options.now?.() ?? new Date();
      const raw = await generateGeminiJson({
        apiKey: options.getApiKey(),
        ...(options.model !== undefined ? { model: options.model } : {}),
        system: systemByField(field, now.toISOString()),
        user: input.freeText,
        schema: outingFreeTextGeminiSchemas[field],
        maxOutputTokens: maxTokensByField[field],
      });

      const unwrapped = unwrapOutingFreeTextGeminiResult(field, raw);

      if (field === "departureAt") {
        const iso = outingFreeTextParse.departureAt(unwrapped);
        const ms = Date.parse(iso);
        if (Number.isNaN(ms)) {
          throw new GeminiServiceError(`Resolved departureAt is not a valid datetime: ${iso}`, 400);
        }
        return new Date(ms).toISOString();
      }

      try {
        return outingFreeTextParse[field](unwrapped);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GeminiServiceError(`Could not resolve ${field} free text: ${message}`, 400);
      }
    },
  };
}
