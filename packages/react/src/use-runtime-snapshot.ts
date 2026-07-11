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
  status: "idle",
  error: null,
};

/**
 * Subscribe to a session's Runtime Snapshot.
 *
 * - Always hydrates via HTTP `GET /sessions/:id/snapshot` (source of truth read).
 * - When realtime is on, also opens an Agents SDK WebSocket (`agents/client`)
 *   and applies state broadcasts. On reconnect, re-fetches HTTP so the client
 *   converges to the latest durable snapshot.
 * - Multiple hooks for the same session share one channel (see `session-channel`).
 */
export function useRuntimeSnapshot(
  sessionId: string | null | undefined,
  options: UseRuntimeSnapshotOptions = {},
): UseRuntimeSnapshotResult {
  const pear = usePearContext();
  const realtime = options.realtime ?? pear.realtime;

  const channelOptions = useMemo(
    () => ({
      realtime,
      agentName: pear.agentName,
      agentSecure: pear.agentSecure,
      baseUrl: pear.baseUrl,
      getContext: pear.getContext,
      ...(options.recentEventLimit === undefined
        ? {}
        : { recentEventLimit: options.recentEventLimit }),
    }),
    [
      realtime,
      pear.agentName,
      pear.agentSecure,
      pear.baseUrl,
      pear.getContext,
      options.recentEventLimit,
    ],
  );

  const [state, setState] = useState<SessionChannelSnapshot>(IDLE_SNAPSHOT);
  const [errorCleared, setErrorCleared] = useState(false);
  const [channelVersion, setChannelVersion] = useState(0);

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
      status: "loading",
      error: null,
    });

    const { channel, release } = acquireSessionChannel(sessionId, pear.client, channelOptions);
    setState(channel.getSnapshot());
    setChannelVersion((v) => v + 1);

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
    // Re-acquire path: channel is retained by the effect; find via temporary retain.
    const { channel, release } = acquireSessionChannel(sessionId, pear.client, channelOptions);
    try {
      await channel.refetch();
      setState(channel.getSnapshot());
    } finally {
      release();
    }
  }, [sessionId, pear.client, channelOptions]);

  // channelVersion keeps refetch/stable identity tied to the active effect channel.
  void channelVersion;

  return {
    snapshot: state.snapshot,
    continuation: state.continuation,
    revision: state.revision,
    status: sessionId ? state.status : "idle",
    error: errorCleared ? null : state.error,
    refetch,
    clearError: () => setErrorCleared(true),
  };
}
