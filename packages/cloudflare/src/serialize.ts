import {
  materializedExecutionStateSchema,
  runtimeEventSchema,
  runtimeSnapshotSchema,
  type MaterializedExecutionState,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "@pear-agent/core";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Field names that Core schemas treat as Date values. */
const DATE_FIELD_NAMES = new Set([
  "createdAt",
  "updatedAt",
  "occurredAt",
  "evaluatedAt",
  "generatedAt",
  "startedAt",
  "endsAt",
  "deadline",
  "lastAppliedEventAt",
]);

/**
 * Revives known Core date field names in a value tree.
 * Safe for Core models; do not apply to Domain normalizedInput payloads.
 */
export function reviveJsonDates(value: unknown, key?: string): unknown {
  if (typeof value === "string" && key && DATE_FIELD_NAMES.has(key) && ISO_DATE_RE.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (Array.isArray(value)) return value.map((item) => reviveJsonDates(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([nestedKey, nested]) => [
        nestedKey,
        reviveJsonDates(nested, nestedKey),
      ]),
    );
  }
  return value;
}

export function serializeJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested instanceof Date) return nested.toISOString();
    return nested;
  });
}

/** JSON.parse without date revival (safe for Domain normalized input payloads). */
export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** JSON.parse that revives known Core date fields only. */
export function parseJsonWithDates(text: string): unknown {
  return reviveJsonDates(JSON.parse(text));
}

export function serializeExecutionState(state: MaterializedExecutionState): string {
  return serializeJson(materializedExecutionStateSchema.parse(state));
}

export function parseExecutionState(text: string): MaterializedExecutionState {
  return materializedExecutionStateSchema.parse(parseJsonWithDates(text));
}

export function serializeRuntimeEvent(event: RuntimeEvent): string {
  return serializeJson(runtimeEventSchema.parse(event));
}

export function parseRuntimeEvent(text: string): RuntimeEvent {
  return runtimeEventSchema.parse(parseJsonWithDates(text));
}

export function serializeRuntimeSnapshot(snapshot: RuntimeSnapshot): string {
  return serializeJson(runtimeSnapshotSchema.parse(snapshot));
}

export function parseRuntimeSnapshot(text: string): RuntimeSnapshot {
  return runtimeSnapshotSchema.parse(parseJsonWithDates(text));
}
