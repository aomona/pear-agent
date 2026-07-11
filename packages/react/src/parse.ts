import {
  materializedExecutionStateSchema,
  runtimeEventSchema,
  runtimeSnapshotSchema,
  voiceLeaseSchema,
  executionContinuationSchema,
  type AppendEventResult,
  type MaterializedExecutionState,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type VoiceLease,
} from "@pear-agent/core";
import { z } from "zod";

import type { ExecutionContinuationStub, ParsedSyncPulse } from "./types.js";

const appendEventResponseSchema = z.object({
  kind: z.enum(["applied", "duplicate"]),
  event: runtimeEventSchema,
  state: materializedExecutionStateSchema,
});

const continuationStubSchema = executionContinuationSchema.nullable();

const syncStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  lastEventId: z.string().nullable().default(null),
  continuation: continuationStubSchema.default(null),
});

export function parseRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  return runtimeSnapshotSchema.parse(value);
}

export function parseMaterializedState(value: unknown): MaterializedExecutionState {
  return materializedExecutionStateSchema.parse(value);
}

export function parseRuntimeEvent(value: unknown): RuntimeEvent {
  return runtimeEventSchema.parse(value);
}

export function parseAppendEventResult(value: unknown): AppendEventResult {
  return appendEventResponseSchema.parse(value);
}

export function parseSyncState(value: unknown): ParsedSyncPulse {
  const raw = syncStateSchema.parse(value);
  return {
    revision: raw.revision,
    lastEventId: raw.lastEventId,
    continuation: raw.continuation as ExecutionContinuationStub | null,
  };
}

export function parseVoiceLease(value: unknown): VoiceLease {
  return voiceLeaseSchema.parse(value);
}

export function parseVoiceLeaseOrNull(value: unknown): VoiceLease | null {
  if (value === null || value === undefined) return null;
  return voiceLeaseSchema.parse(value);
}

export function parseExecutionContinuation(value: unknown): ExecutionContinuationStub {
  return executionContinuationSchema.parse(value);
}
