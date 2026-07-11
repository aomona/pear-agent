import type { UseRuntimeSnapshotOptions } from "./use-runtime-snapshot.js";
import { useRuntimeSnapshot } from "./use-runtime-snapshot.js";
import type { ConnectionStatus, ExecutionContinuationStub } from "./types.js";

export type UseContinuationResult = {
  /**
   * Active continuation for the session, or null.
   * Always null until Issue #7 implements suspend/wake persistence.
   */
  continuation: ExecutionContinuationStub | null;
  /** Convenience: continuation?.status ?? "none" */
  status: ExecutionContinuationStub["status"] | "none";
  connectionStatus: ConnectionStatus;
  error: Error | null;
  refetch: () => Promise<void>;
};

/**
 * Thin Continuation read model (Issue #5 stub).
 *
 * Subscribes to the same snapshot/sync channel as {@link useRuntimeSnapshot}
 * and surfaces `continuation`. Full suspend / wake / atomic resume ships in #7.
 */
export function useContinuation(
  sessionId: string | null | undefined,
  options: UseRuntimeSnapshotOptions = {},
): UseContinuationResult {
  const {
    continuation,
    status: connectionStatus,
    error,
    refetch,
  } = useRuntimeSnapshot(sessionId, options);

  return {
    continuation,
    status: continuation?.status ?? "none",
    connectionStatus,
    error,
    refetch,
  };
}
