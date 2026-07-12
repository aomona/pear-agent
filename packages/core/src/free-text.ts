import { z } from "zod";

/**
 * Per-field free-text envelope for Domain input schemas.
 * Pair with structured values via `z.union([structuredSchema, freeTextValueSchema])`.
 */
export const freeTextValueSchema = z.object({
  freeText: z.string().trim().min(1).max(4_000),
});

export type FreeTextValue = z.infer<typeof freeTextValueSchema>;

export function isFreeTextValue(value: unknown): value is FreeTextValue {
  return freeTextValueSchema.safeParse(value).success;
}

/**
 * Host Port: turn free text for one input field into a structured value.
 * Typical implementation: LLM structured output; tests use deterministic parsers.
 */
export type FreeTextFieldResolver = {
  resolve(input: {
    domainId: string;
    /** Dot path or field name, e.g. `departureAt`, `belongings`. */
    field: string;
    freeText: string;
    /** Domain-provided hint for the target shape. */
    hint?: string;
    context?: unknown;
  }): Promise<unknown>;
};

export type NormalizeInputContext = {
  /** Resolves free-text fields that Domain cannot parse deterministically. */
  freeTextResolver?: FreeTextFieldResolver;
  /** Opaque host context (auth, locale, etc.). */
  context?: unknown;
};

/**
 * Resolve a field that may be structured or free-text.
 * 1) If structured, return as-is
 * 2) If free-text, try `parseDeterministic` when provided
 * 3) Else require `freeTextResolver`
 */
export async function resolveMaybeFreeTextField<T>(input: {
  domainId: string;
  field: string;
  value: T | FreeTextValue;
  freeTextResolver?: FreeTextFieldResolver;
  parseDeterministic?: (freeText: string) => T | null;
  hint?: string;
  context?: unknown;
}): Promise<T> {
  if (!isFreeTextValue(input.value)) {
    return input.value;
  }

  const text = input.value.freeText;
  if (input.parseDeterministic) {
    const parsed = input.parseDeterministic(text);
    if (parsed !== null) return parsed;
  }

  if (!input.freeTextResolver) {
    throw new Error(
      `Free-text field "${input.field}" could not be parsed and no freeTextResolver was provided`,
    );
  }

  const resolveInput: {
    domainId: string;
    field: string;
    freeText: string;
    hint?: string;
    context?: unknown;
  } = {
    domainId: input.domainId,
    field: input.field,
    freeText: text,
  };
  if (input.hint !== undefined) resolveInput.hint = input.hint;
  if (input.context !== undefined) resolveInput.context = input.context;

  return (await input.freeTextResolver.resolve(resolveInput)) as T;
}
