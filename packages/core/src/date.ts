import { z } from "zod";

/**
 * Core date fields at wire/parse boundaries.
 * Accepts `Date` or ISO-8601 datetime with offset (e.g. `…Z`, `…+00:00`);
 * always outputs `Date`.
 *
 * Domain JSON (`facts`, `domainData`, json payloads) must use `jsonValueSchema`
 * so ISO strings under Domain keys are never coerced to Date.
 */
export const dateSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
]);
