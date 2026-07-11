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
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

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
    async (sid: string, conn: VoiceConnection, calls: VoiceToolCall[]) => {
      const responses: {
        id: string;
        name: string;
        response: Record<string, unknown>;
      }[] = [];

      for (const call of calls) {
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

      conn.sendToolResponse(responses);
    },
    [appendTranscript],
  );

  const bindConnection = useCallback(
    (sid: string, conn: VoiceConnection) => {
      clearSubscriptions();
      connectionRef.current = conn;
      setConnection(conn);
      setStatus(conn.status);

      unsubscribersRef.current.push(
        conn.on("status", (next) => {
          setStatus(next);
        }),
        conn.on("error", (err) => {
          setError(err);
          setStatus("error");
        }),
        conn.on("transcript", (entry) => {
          appendTranscript(entry);
        }),
        conn.on("resumeHandle", (handle) => {
          void clientRef.current
            .setVoiceResumeHandle(sid, handle)
            .then(setLease)
            .catch(() => undefined);
        }),
        conn.on("toolCall", (calls) => {
          toolQueueRef.current = toolQueueRef.current
            .catch(() => undefined)
            .then(() => handleToolCalls(sid, conn, calls))
            .catch((caught) => {
              const next = caught instanceof Error ? caught : new Error(String(caught));
              setError(next);
            });
        }),
      );
    },
    [appendTranscript, clearSubscriptions, handleToolCalls],
  );

  const disconnect = useCallback(async () => {
    if (disconnectingRef.current) return;
    disconnectingRef.current = true;
    const sid = sessionIdRef.current;
    try {
      clearSubscriptions();
      const conn = connectionRef.current;
      connectionRef.current = null;
      setConnection(null);
      if (conn) {
        await conn.disconnect();
      }
      if (sid) {
        try {
          const released = await clientRef.current.releaseVoiceLease(sid);
          setLease(released);
        } catch {
          setLease(null);
        }
      } else {
        setLease(null);
      }
      setStatus("disconnected");
      connectingRef.current = false;
      appendTranscript({ role: "status", text: "Voice disconnected (session continues)." });
    } finally {
      disconnectingRef.current = false;
    }
  }, [appendTranscript, clearSubscriptions]);

  const connect = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) {
      throw new Error("sessionId is required to connect voice");
    }
    if (connectingRef.current) return;
    connectingRef.current = true;

    setError(null);
    setStatus("connecting");
    appendTranscript({ role: "status", text: "Connecting voice…" });

    try {
      const acquired = await clientRef.current.acquireVoiceLease(sid);
      setLease(acquired);

      const minted = await clientRef.current.mintVoiceToken(sid);
      const conn = await providerRef.current.connect({
        credentials: { token: minted.token, model: minted.model },
        resumeHandle: acquired.providerResumeHandle,
      });
      bindConnection(sid, conn);
      appendTranscript({ role: "status", text: "Voice connected." });
    } catch (caught) {
      const next = caught instanceof Error ? caught : new Error(String(caught));
      setError(next);
      setStatus("error");
      try {
        await clientRef.current.releaseVoiceLease(sid);
      } catch {
        // ignore
      }
      setLease(null);
      throw next;
    } finally {
      connectingRef.current = false;
    }
  }, [appendTranscript, bindConnection]);

  const refetchLease = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) {
      setLease(null);
      return;
    }
    const next = await clientRef.current.getVoiceLease(sid);
    setLease(next);
  }, []);

  const mute = useCallback(() => {
    connectionRef.current?.mute();
  }, []);

  const unmute = useCallback(() => {
    connectionRef.current?.unmute();
  }, []);

  // Session-scoped cleanup: release voice only (never cancel Execution Session).
  useEffect(() => {
    setStatus("idle");
    setLease(null);
    setError(null);
    setTranscript([]);
    connectingRef.current = false;

    return () => {
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
