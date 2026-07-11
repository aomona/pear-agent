import {
  materializedExecutionStateSchema,
  runtimeEventSchema,
  runtimeSnapshotSchema,
  type MaterializedExecutionState,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "@pear-agent/core";

/**
 * Serialize values for D1 JSON columns and HTTP JSON bodies.
 * Core `Date` instances become ISO-8601 strings; Domain JSON is left as-is.
 */
export function serializeJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested instanceof Date) return nested.toISOString();
    return nested;
  });
}

/**
 * Plain JSON-safe value for `c.json` / DO-adjacent responses.
 * Core schemas coerce ISO strings back to `Date` on parse; Domain blobs stay strings.
 */
export function toJsonValue<T>(value: T): unknown {
  return JSON.parse(serializeJson(value));
}

/** JSON.parse without date magic (Domain normalized input, opaque payloads). */
export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * Parse Core models from D1/HTTP JSON.
 * Date coercion lives only on Core schema leaves (`dateSchema`); nested Domain
 * JSON under `facts` / `domainData` / json payloads is never rewritten by key name.
 */
export function serializeExecutionState(state: MaterializedExecutionState): string {
  return serializeJson(materializedExecutionStateSchema.parse(state));
}

export function parseExecutionState(text: string): MaterializedExecutionState {
  return materializedExecutionStateSchema.parse(parseJson(text));
}

export function serializeRuntimeEvent(event: RuntimeEvent): string {
  return serializeJson(runtimeEventSchema.parse(event));
}

export function parseRuntimeEvent(text: string): RuntimeEvent {
  return runtimeEventSchema.parse(parseJson(text));
}

/** Parse a RuntimeEvent from an already-decoded JSON value (HTTP body). */
export function parseRuntimeEventValue(value: unknown): RuntimeEvent {
  return runtimeEventSchema.parse(value);
}

export function serializeRuntimeSnapshot(snapshot: RuntimeSnapshot): string {
  return serializeJson(runtimeSnapshotSchema.parse(snapshot));
}

export function parseRuntimeSnapshot(text: string): RuntimeSnapshot {
  return runtimeSnapshotSchema.parse(parseJson(text));
}
