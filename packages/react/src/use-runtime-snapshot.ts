import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeSnapshot } from "@pear-agent/core";

import { parseSyncState } from "./parse.js";
import { usePearContext } from "./provider.js";
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

function hostFromBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

/**
 * Subscribe to a session's Runtime Snapshot.
 *
 * - Always hydrates via HTTP `GET /sessions/:id/snapshot` (source of truth read).
 * - When realtime is on, also opens an Agents SDK WebSocket (`agents/client`)
 *   and applies state broadcasts. On reconnect, re-fetches HTTP so the client
 *   converges to the latest durable snapshot.
 */
export function useRuntimeSnapshot(
  sessionId: string | null | undefined,
  options: UseRuntimeSnapshotOptions = {},
): UseRuntimeSnapshotResult {
  const pear = usePearContext();
  const realtime = options.realtime ?? pear.realtime;

  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [continuation, setContinuation] = useState<ExecutionContinuationStub | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<ConnectionStatus>(sessionId ? "loading" : "idle");
  const [error, setError] = useState<Error | null>(null);

  const lastRevisionRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const applySync = useCallback((raw: unknown) => {
    try {
      const parsed = parseSyncState(raw);
      if (parsed.revision < lastRevisionRef.current) {
        return;
      }
      lastRevisionRef.current = parsed.revision;
      setRevision(parsed.revision);
      setSnapshot(parsed.snapshot);
      setContinuation(parsed.continuation);
      setStatus("connected");
      setError(null);
    } catch (caught) {
      const next = caught instanceof Error ? caught : new Error(String(caught));
      setError(next);
      setStatus("error");
    }
  }, []);

  const refetch = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) {
      setSnapshot(null);
      setContinuation(null);
      setRevision(0);
      lastRevisionRef.current = 0;
      setStatus("idle");
      return;
    }

    try {
      const next = await pear.client.getSnapshot(
        id,
        options.recentEventLimit === undefined
          ? undefined
          : { recentEventLimit: options.recentEventLimit },
      );
      setSnapshot(next);
      setError(null);
      setStatus("connected");
    } catch (caught) {
      const nextErr = caught instanceof Error ? caught : new Error(String(caught));
      setError(nextErr);
      setStatus("error");
    }
  }, [pear.client, options.recentEventLimit]);

  // Initial + sessionId-change HTTP hydrate
  useEffect(() => {
    if (!sessionId) {
      setSnapshot(null);
      setContinuation(null);
      setRevision(0);
      lastRevisionRef.current = 0;
      setStatus("idle");
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus("loading");
    void (async () => {
      try {
        const next = await pear.client.getSnapshot(
          sessionId,
          options.recentEventLimit === undefined
            ? undefined
            : { recentEventLimit: options.recentEventLimit },
        );
        if (cancelled) return;
        setSnapshot(next);
        setError(null);
        setStatus("connected");
      } catch (caught) {
        if (cancelled) return;
        const nextErr = caught instanceof Error ? caught : new Error(String(caught));
        setError(nextErr);
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, pear.client, options.recentEventLimit]);

  // Agents realtime subscription (dynamic import so HTTP-only tests skip the peer)
  useEffect(() => {
    if (!realtime || !sessionId) {
      return;
    }

    let closed = false;
    let socket: { close: () => void } | null = null;
    const agentHost = hostFromBaseUrl(pear.baseUrl);

    void import("agents/client")
      .then(({ AgentClient }) => {
        if (closed) return;

        const client = new AgentClient({
          agent: pear.agentName,
          name: sessionId,
          host: agentHost,
          onStateUpdate: (state: unknown) => {
            if (closed) return;
            applySync(state);
          },
          onConnectionError: (connectionError: Error) => {
            if (closed) return;
            setError(connectionError);
            setStatus("error");
          },
        });

        const onOpen = () => {
          if (closed) return;
          setStatus("connected");
          // Converge to durable snapshot after (re)connect.
          void refetch();
        };
        const onClose = () => {
          if (closed) return;
          setStatus("reconnecting");
        };
        const onError = () => {
          if (closed) return;
          setStatus("reconnecting");
        };

        client.addEventListener("open", onOpen);
        client.addEventListener("close", onClose);
        client.addEventListener("error", onError);

        socket = {
          close: () => {
            client.removeEventListener("open", onOpen);
            client.removeEventListener("close", onClose);
            client.removeEventListener("error", onError);
            client.close();
          },
        };
      })
      .catch((caught: unknown) => {
        if (closed) return;
        const nextErr =
          caught instanceof Error
            ? caught
            : new Error("Failed to load agents/client for realtime sync");
        setError(nextErr);
        setStatus("error");
      });

    return () => {
      closed = true;
      socket?.close();
    };
  }, [realtime, sessionId, pear.baseUrl, pear.agentName, applySync, refetch]);

  return {
    snapshot,
    continuation,
    revision,
    status,
    error,
    refetch,
    clearError: () => setError(null),
  };
}
