import { useCallback, useEffect, useMemo, useReducer } from "react";
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

type SnapshotView = {
  channel: SessionChannelSnapshot;
  errorCleared: boolean;
};

const IDLE_CHANNEL: SessionChannelSnapshot = {
  snapshot: null,
  continuation: null,
  revision: 0,
  lastEventId: null,
  status: "idle",
  error: null,
};

const IDLE_VIEW: SnapshotView = {
  channel: IDLE_CHANNEL,
  errorCleared: false,
};

type SnapshotAction =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "channel"; channel: SessionChannelSnapshot; clearError?: boolean }
  | { type: "clear-error" };

function snapshotReducer(state: SnapshotView, action: SnapshotAction): SnapshotView {
  switch (action.type) {
    case "idle":
      return IDLE_VIEW;
    case "loading":
      return {
        errorCleared: false,
        channel: {
          snapshot: null,
          continuation: null,
          revision: 0,
          lastEventId: null,
          status: "loading",
          error: null,
        },
      };
    case "channel":
      return {
        errorCleared: action.clearError === true ? false : state.errorCleared,
        channel: action.channel,
      };
    case "clear-error":
      return { ...state, errorCleared: true };
    default:
      return state;
  }
}

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

  const [view, dispatch] = useReducer(snapshotReducer, IDLE_VIEW);

  useEffect(() => {
    if (!sessionId) {
      dispatch({ type: "idle" });
      return;
    }

    // One reducer action for reset + one for first channel snapshot (not N setStates).
    dispatch({ type: "loading" });

    const { channel, release } = acquireSessionChannel(sessionId, pear.client, channelOptions);
    dispatch({ type: "channel", channel: channel.getSnapshot(), clearError: true });

    const unsubscribe = channel.subscribe(() => {
      dispatch({ type: "channel", channel: channel.getSnapshot(), clearError: true });
    });

    return () => {
      unsubscribe();
      release();
    };
  }, [sessionId, pear.client, channelOptions]);

  const refetch = useCallback(async () => {
    if (!sessionId) return;
    const { channel, release } = acquireSessionChannel(sessionId, pear.client, channelOptions);
    try {
      await channel.refetch();
      dispatch({ type: "channel", channel: channel.getSnapshot(), clearError: true });
    } finally {
      release();
    }
  }, [sessionId, pear.client, channelOptions]);

  return {
    snapshot: view.channel.snapshot,
    continuation: view.channel.continuation,
    revision: view.channel.revision,
    lastEventId: view.channel.lastEventId,
    status: sessionId ? view.channel.status : "idle",
    error: view.errorCleared ? null : view.channel.error,
    refetch,
    clearError: () => dispatch({ type: "clear-error" }),
  };
}
