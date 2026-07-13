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
 * Return value is always re-validated by the caller via `parse`.
 */
export type FreeTextFieldResolver = {
  resolve(input: {
    domainId: string;
    /** Dot path or field name, e.g. `departureAt`, `belongings`. */
    field: string;
    freeText: string;
    /** Domain-provided hint for the target shape. */
    hint?: string | undefined;
    context?: unknown;
  }): Promise<unknown>;
};

export type NormalizeInputContext = {
  /** Resolves free-text fields that Domain cannot parse deterministically. */
  freeTextResolver?: FreeTextFieldResolver | undefined;
  /** Opaque host context (auth, locale, etc.). */
  context?: unknown;
};

export type ResolveMaybeFreeTextFieldInput<T> = {
  domainId: string;
  field: string;
  value: unknown;
  /** Always applied to structured values, deterministic parse, and resolver output. */
  parse: (value: unknown) => T;
  freeTextResolver?: FreeTextFieldResolver | undefined;
  parseDeterministic?: ((freeText: string) => unknown | null) | undefined;
  hint?: string | undefined;
  context?: unknown;
};

/**
 * Resolve a field that may be structured or free-text, then always `parse`.
 * 1) structured value → parse
 * 2) free-text → deterministic parse if provided
 * 3) else freeTextResolver
 * 4) parse result
 */
export async function resolveMaybeFreeTextField<T>(
  input: ResolveMaybeFreeTextFieldInput<T>,
): Promise<T> {
  if (!isFreeTextValue(input.value)) {
    return input.parse(input.value);
  }

  const text = input.value.freeText;
  if (input.parseDeterministic) {
    const parsed = input.parseDeterministic(text);
    if (parsed !== null) return input.parse(parsed);
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

  const resolved = await input.freeTextResolver.resolve(resolveInput);
  return input.parse(resolved);
}
