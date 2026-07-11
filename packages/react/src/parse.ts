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

import type { ExecutionContinuationStub, ParsedSyncPulse } from "./types.js";

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
