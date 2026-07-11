import type { UseRuntimeSnapshotOptions } from "./use-runtime-snapshot.js";
import { useRuntimeSnapshot } from "./use-runtime-snapshot.js";
import type { ConnectionStatus, ExecutionContinuationStub } from "./types.js";
import type {
  ContinuationWakeCondition,
  ExecutionContinuation,
  RuntimeSnapshot,
} from "@pear-agent/core";
import { usePearContext } from "./provider.js";

export type UseContinuationResult = {
  /**
   * Active continuation for the session, or null.
   */
  continuation: ExecutionContinuationStub | null;
  /** Convenience: continuation?.status ?? "none" */
  status: ExecutionContinuationStub["status"] | "none";
  connectionStatus: ConnectionStatus;
  error: Error | null;
  refetch: () => Promise<void>;
  suspend: (input: {
    id?: string;
    wakeCondition: ContinuationWakeCondition;
    suspendedReason: string;
    resumeDirective: string;
  }) => Promise<ExecutionContinuation>;
  claimResume: (continuationId: string) => Promise<{
    continuation: ExecutionContinuation;
    snapshot: RuntimeSnapshot;
  }>;
  complete: (continuationId: string, attemptId: string) => Promise<ExecutionContinuation>;
};

/**
 * Shares the same {@link useRuntimeSnapshot} session channel (one HTTP hydrate
 * and one Agent WebSocket per session in the tree).
 */
export function useContinuation(
  sessionId: string | null | undefined,
  options: UseRuntimeSnapshotOptions = {},
): UseContinuationResult {
  const { client } = usePearContext();
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
    suspend: async (input) => {
      if (!sessionId) throw new Error("sessionId is required to suspend");
      const result = await client.suspendContinuation(sessionId, input);
      await refetch();
      return result;
    },
    claimResume: async (continuationId) => {
      if (!sessionId) throw new Error("sessionId is required to resume");
      const result = await client.claimContinuationResume(sessionId, continuationId);
      await refetch();
      return result;
    },
    complete: async (continuationId, attemptId) => {
      if (!sessionId) throw new Error("sessionId is required to complete a continuation");
      const result = await client.completeContinuation(sessionId, continuationId, attemptId);
      await refetch();
      return result;
    },
  };
}
