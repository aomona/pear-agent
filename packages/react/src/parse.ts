import {
  materializedExecutionStateSchema,
  runtimeEventSchema,
  runtimeSnapshotSchema,
  type AppendEventResult,
  type MaterializedExecutionState,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "@pear-agent/core";
import { z } from "zod";

import type { ExecutionContinuationStub, ExecutionSessionSyncState } from "./types.js";

const appendEventResponseSchema = z.object({
  kind: z.enum(["applied", "duplicate"]),
  event: runtimeEventSchema,
  state: materializedExecutionStateSchema,
});

const continuationStubSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    status: z.enum(["suspended", "wake_pending", "resuming", "completed", "expired"]),
    wakeCondition: z.union([
      z.object({ type: z.literal("manual") }),
      z.object({ type: z.literal("time"), wakeAt: z.string() }),
      z.object({ type: z.literal("event"), eventType: z.string() }),
    ]),
    suspendedReason: z.string(),
    resumeDirective: z.string(),
    checkpointPlanVersionId: z.string(),
    checkpointLastEventId: z.string().nullable(),
    providerResumeHandle: z.string().nullable(),
  })
  .nullable();

const syncStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  snapshot: z.unknown().nullable(),
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

export function parseSyncState(value: unknown): {
  revision: number;
  snapshot: RuntimeSnapshot | null;
  continuation: ExecutionContinuationStub | null;
} {
  const raw = syncStateSchema.parse(value) as ExecutionSessionSyncState;
  return {
    revision: raw.revision,
    snapshot: raw.snapshot === null ? null : parseRuntimeSnapshot(raw.snapshot),
    continuation: raw.continuation,
  };
}
