import {
  FakeVoiceProvider,
  type VoiceConnection,
  type VoiceLease,
  type VoiceProvider,
  type VoiceSessionStatus,
  type VoiceToolCall,
  type VoiceTranscriptEntry,
} from "@pear-agent/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { usePearContext } from "./provider.js";
import { GeminiLiveVoiceProvider } from "./voice/gemini-live-provider.js";

export type UseVoiceSessionOptions = {
  /**
   * Inject a VoiceProvider (tests: FakeVoiceProvider).
   * Default: {@link GeminiLiveVoiceProvider}.
   */
  provider?: VoiceProvider;
};

export type UseVoiceSessionResult = {
  status: VoiceSessionStatus | "idle";
  lease: VoiceLease | null;
  error: Error | null;
  transcript: VoiceTranscriptEntry[];
  /** Acquire lease, mint token, open Voice connection. Does not start Execution Session. */
  connect: () => Promise<void>;
  /**
   * Close Voice connection and release lease.
   * Never cancels or pauses the Execution Session.
   */
  disconnect: () => Promise<void>;
  mute: () => void;
  unmute: () => void;
  refetchLease: () => Promise<void>;
  clearError: () => void;
  /** Low-level connection when connected (for advanced hosts). */
  connection: VoiceConnection | null;
};

/**
 * Voice Session lifecycle for one Execution Session.
 *
 * - Exclusive Voice Lease (Worker-enforced)
 * - Ephemeral token + VoiceProvider connection
 * - Tool calls bridged to `POST /sessions/:id/voice/tools`
 * - Disconnect releases lease only — Execution Session keeps running
 */
export function useVoiceSession(
  sessionId: string | null | undefined,
  options: UseVoiceSessionOptions = {},
): UseVoiceSessionResult {
  const { client } = usePearContext();
  const providerRef = useRef<VoiceProvider>(options.provider ?? new GeminiLiveVoiceProvider());
  if (options.provider) {
    providerRef.current = options.provider;
  }

  const clientRef = useRef(client);
  clientRef.current = client;

  /** Prop-facing session id (for connect / refetch). */
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  /**
   * Session that currently owns the voice connection / lease.
   * Must not track the latest prop — cleanup must release the bound session.
   */
  const boundSessionIdRef = useRef<string | null>(null);

  /**
   * Bumped on sessionId change (and intentional lifecycle resets) so in-flight
   * async connect/disconnect never apply setState to a superseded generation.
   */
  const epochRef = useRef(0);

  const [status, setStatus] = useState<VoiceSessionStatus | "idle">("idle");
  const [lease, setLease] = useState<VoiceLease | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);
  const [connection, setConnection] = useState<VoiceConnection | null>(null);

  const connectionRef = useRef<VoiceConnection | null>(null);
  const unsubscribersRef = useRef<Array<() => void>>([]);
  const toolQueueRef = useRef(Promise.resolve());
  const disconnectingRef = useRef(false);
  const connectingRef = useRef(false);

  const isCurrent = useCallback((epoch: number) => epochRef.current === epoch, []);

  const clearSubscriptions = useCallback(() => {
    for (const unsub of unsubscribersRef.current) {
      unsub();
    }
    unsubscribersRef.current = [];
  }, []);

  const appendTranscript = useCallback((entry: VoiceTranscriptEntry) => {
    setTranscript((prev) => [...prev, entry].slice(-40));
  }, []);

  const handleToolCalls = useCallback(
    async (sid: string, conn: VoiceConnection, calls: VoiceToolCall[], epoch: number) => {
      const responses: {
        id: string;
        name: string;
        response: Record<string, unknown>;
      }[] = [];

      for (const call of calls) {
        if (!isCurrent(epoch)) return;
        appendTranscript({ role: "tool", text: `tool: ${call.name}` });
        try {
          const result = await clientRef.current.executeVoiceTool(sid, {
            toolName: call.name,
            args: call.args,
            callId: call.id,
          });
          if (result.ok) {
            responses.push({
              id: call.id,
              name: call.name,
              response: { result: result.result ?? null },
            });
          } else {
            responses.push({
              id: call.id,
              name: call.name,
              response: {
                error: true,
                message: result.message ?? `Tool failed: ${call.name}`,
              },
            });
          }
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          responses.push({
            id: call.id,
            name: call.name,
            response: { error: true, message },
          });
        }
      }

      if (!isCurrent(epoch)) return;
      conn.sendToolResponse(responses);
    },
    [appendTranscript, isCurrent],
  );

  const bindConnection = useCallback(
    (sid: string, conn: VoiceConnection, epoch: number) => {
      clearSubscriptions();
      connectionRef.current = conn;
      boundSessionIdRef.current = sid;
      if (!isCurrent(epoch)) return;
      setConnection(conn);
      setStatus(conn.status);

      unsubscribersRef.current.push(
        conn.on("status", (next) => {
          if (!isCurrent(epoch)) return;
          setStatus(next);
        }),
        conn.on("error", (err) => {
          if (!isCurrent(epoch)) return;
          setError(err);
          setStatus("error");
        }),
        conn.on("transcript", (entry) => {
          if (!isCurrent(epoch)) return;
          appendTranscript(entry);
        }),
        conn.on("resumeHandle", (handle) => {
          void clientRef.current
            .setVoiceResumeHandle(sid, handle)
            .then((nextLease) => {
              if (!isCurrent(epoch)) return;
              setLease(nextLease);
            })
            .catch(() => undefined);
        }),
        conn.on("toolCall", (calls) => {
          toolQueueRef.current = toolQueueRef.current
            .catch(() => undefined)
            .then(() => handleToolCalls(sid, conn, calls, epoch))
            .catch((caught) => {
              if (!isCurrent(epoch)) return;
              const next = caught instanceof Error ? caught : new Error(String(caught));
              setError(next);
            });
        }),
      );
    },
    [appendTranscript, clearSubscriptions, handleToolCalls, isCurrent],
  );

  const disconnect = useCallback(async () => {
    if (disconnectingRef.current) return;
    disconnectingRef.current = true;
    const epoch = epochRef.current;
    // Always release the session that holds the connection, not the latest prop.
    const sid = boundSessionIdRef.current;
    try {
      clearSubscriptions();
      const conn = connectionRef.current;
      connectionRef.current = null;
      if (isCurrent(epoch)) {
        setConnection(null);
      }
      if (conn) {
        await conn.disconnect();
      }
      if (sid) {
        try {
          const released = await clientRef.current.releaseVoiceLease(sid);
          if (isCurrent(epoch)) {
            setLease(released);
          }
        } catch {
          if (isCurrent(epoch)) {
            setLease(null);
          }
        }
      } else if (isCurrent(epoch)) {
        setLease(null);
      }
      boundSessionIdRef.current = null;
      connectingRef.current = false;
      if (isCurrent(epoch)) {
        setStatus("disconnected");
        appendTranscript({ role: "status", text: "Voice disconnected (session continues)." });
      }
    } finally {
      disconnectingRef.current = false;
    }
  }, [appendTranscript, clearSubscriptions, isCurrent]);

  const connect = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) {
      throw new Error("sessionId is required to connect voice");
    }

    // Mid-connect retarget: abort current generation and release prior bound lease.
    if (connectingRef.current) {
      if (boundSessionIdRef.current === sid) {
        return;
      }
      epochRef.current += 1;
      connectingRef.current = false;
      await disconnect();
    } else if (boundSessionIdRef.current && boundSessionIdRef.current !== sid) {
      await disconnect();
    }

    const epoch = epochRef.current;
    connectingRef.current = true;

    if (isCurrent(epoch)) {
      setError(null);
      setStatus("connecting");
      appendTranscript({ role: "status", text: "Connecting voice…" });
    }

    try {
      const acquired = await clientRef.current.acquireVoiceLease(sid);
      if (!isCurrent(epoch)) {
        // Superseded: drop lease we just acquired for this stale attempt.
        try {
          await clientRef.current.releaseVoiceLease(sid);
        } catch {
          // ignore
        }
        return;
      }
      setLease(acquired);
      // Pin lease owner before WS open so cleanup can release on failure paths.
      boundSessionIdRef.current = sid;

      const minted = await clientRef.current.mintVoiceToken(sid);
      if (!isCurrent(epoch)) {
        try {
          await clientRef.current.releaseVoiceLease(sid);
        } catch {
          // ignore
        }
        boundSessionIdRef.current = null;
        return;
      }

      const conn = await providerRef.current.connect({
        credentials: { token: minted.token, model: minted.model },
        resumeHandle: acquired.providerResumeHandle,
      });
      if (!isCurrent(epoch)) {
        await conn.disconnect();
        try {
          await clientRef.current.releaseVoiceLease(sid);
        } catch {
          // ignore
        }
        boundSessionIdRef.current = null;
        return;
      }

      bindConnection(sid, conn, epoch);
      appendTranscript({ role: "status", text: "Voice connected." });
    } catch (caught) {
      const next = caught instanceof Error ? caught : new Error(String(caught));
      const bound = boundSessionIdRef.current;
      if (bound) {
        try {
          await clientRef.current.releaseVoiceLease(bound);
        } catch {
          // ignore
        }
        if (boundSessionIdRef.current === bound) {
          boundSessionIdRef.current = null;
        }
      }
      if (isCurrent(epoch)) {
        setError(next);
        setStatus("error");
        setLease(null);
      }
      throw next;
    } finally {
      if (isCurrent(epoch)) {
        connectingRef.current = false;
      }
    }
  }, [appendTranscript, bindConnection, disconnect, isCurrent]);

  const refetchLease = useCallback(async () => {
    const sid = sessionIdRef.current;
    const epoch = epochRef.current;
    if (!sid) {
      if (isCurrent(epoch)) setLease(null);
      return;
    }
    const next = await clientRef.current.getVoiceLease(sid);
    if (isCurrent(epoch)) {
      setLease(next);
    }
  }, [isCurrent]);

  const mute = useCallback(() => {
    connectionRef.current?.mute();
  }, []);

  const unmute = useCallback(() => {
    connectionRef.current?.unmute();
  }, []);

  // Session-scoped cleanup: release voice only (never cancel Execution Session).
  useEffect(() => {
    epochRef.current += 1;
    connectingRef.current = false;
    setStatus("idle");
    setLease(null);
    setError(null);
    setTranscript([]);

    return () => {
      epochRef.current += 1;
      void disconnect();
    };
  }, [sessionId, disconnect]);

  return {
    status: sessionId ? status : "idle",
    lease,
    error,
    transcript,
    connect,
    disconnect,
    mute,
    unmute,
    refetchLease,
    clearError: () => setError(null),
    connection,
  };
}

/** Re-export for hosts that want Fake without importing core. */
export { FakeVoiceProvider, GeminiLiveVoiceProvider };
