import { useCallback, useEffect, useMemo, useState } from "react";
import type { RuntimeSnapshot } from "@pear-agent/core";

import { usePearContext } from "./provider.js";
import { acquireSessionChannel, type SessionChannelSnapshot } from "./session-channel.js";
import type { ConnectionStatus, ExecutionContinuationStub } from "./types.js";

export type UseRuntimeSnapshotOptions = {
  /** Max events when fetching HTTP snapshot (initial + refetch). */
  recentEventLimit?: number;
  /**
   * When false, skip Agents WebSocket and only use HTTP.
   * Defaults to provider `realtime` (true).
   */
  realtime?: boolean;
};

export type UseRuntimeSnapshotResult = {
  snapshot: RuntimeSnapshot | null;
  continuation: ExecutionContinuationStub | null;
  revision: number;
  lastEventId: string | null;
  status: ConnectionStatus;
  error: Error | null;
  /** Force HTTP re-fetch of the latest snapshot (also used after reconnect). */
  refetch: () => Promise<void>;
  clearError: () => void;
};

const IDLE_SNAPSHOT: SessionChannelSnapshot = {
  snapshot: null,
  continuation: null,
  revision: 0,
  lastEventId: null,
  status: "idle",
  error: null,
};

/**
 * Subscribe to a session's Runtime Snapshot.
 *
 * - Always hydrates via HTTP `GET /sessions/:id/snapshot` (source of truth read).
 * - When realtime is on, opens an Agents SDK WebSocket and listens for
 *   invalidation pulses (`revision` / `lastEventId`). On advance or reconnect,
 *   re-fetches HTTP so the client converges to the latest durable snapshot.
 * - Multiple hooks for the same session + client share one channel.
 */
export function useRuntimeSnapshot(
  sessionId: string | null | undefined,
  options: UseRuntimeSnapshotOptions = {},
): UseRuntimeSnapshotResult {
  const pear = usePearContext();

  const channelOptions = useMemo(
    () => ({
      realtime: options.realtime ?? pear.realtime,
      agentName: pear.agentName,
      agentSecure: pear.agentSecure,
      baseUrl: pear.baseUrl,
      getContext: pear.getContext,
      ...(options.recentEventLimit === undefined
        ? {}
        : { recentEventLimit: options.recentEventLimit }),
    }),
    [
      options.realtime,
      options.recentEventLimit,
      pear.realtime,
      pear.agentName,
      pear.agentSecure,
      pear.baseUrl,
      pear.getContext,
    ],
  );

  const [state, setState] = useState<SessionChannelSnapshot>(IDLE_SNAPSHOT);
  const [errorCleared, setErrorCleared] = useState(false);

  useEffect(() => {
    setErrorCleared(false);

    if (!sessionId) {
      setState(IDLE_SNAPSHOT);
      return;
    }

    // Reset local view immediately so session switches do not keep prior revision/snapshot.
    setState({
      snapshot: null,
      continuation: null,
      revision: 0,
      lastEventId: null,
      status: "loading",
      error: null,
    });

    const { channel, release } = acquireSessionChannel(sessionId, pear.client, channelOptions);
    setState(channel.getSnapshot());

    const unsubscribe = channel.subscribe(() => {
      setErrorCleared(false);
      setState(channel.getSnapshot());
    });

    return () => {
      unsubscribe();
      release();
    };
  }, [sessionId, pear.client, channelOptions]);

  const refetch = useCallback(async () => {
    if (!sessionId) return;
    setErrorCleared(false);
    const { channel, release } = acquireSessionChannel(sessionId, pear.client, channelOptions);
    try {
      await channel.refetch();
      setState(channel.getSnapshot());
    } finally {
      release();
    }
  }, [sessionId, pear.client, channelOptions]);

  return {
    snapshot: state.snapshot,
    continuation: state.continuation,
    revision: state.revision,
    lastEventId: state.lastEventId,
    status: sessionId ? state.status : "idle",
    error: errorCleared ? null : state.error,
    refetch,
    clearError: () => setErrorCleared(true),
  };
}
