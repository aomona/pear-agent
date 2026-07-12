import {
  FakeVoiceProvider,
  type VoiceConnection,
  type VoiceLease,
  type VoiceProvider,
  type VoiceSessionStatus,
  type VoiceToolCall,
  type VoiceTranscriptEntry,
  type ContinuationWakeCondition,
  type ExecutionContinuation,
} from "@pear-agent/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { usePearContext } from "./provider.js";
import { attachBrowserVoiceMedia, type BrowserVoiceMediaHandle } from "./voice/browser-media.js";
import { GeminiLiveVoiceProvider } from "./voice/gemini-live-provider.js";
import { attachVoiceConnectionListeners } from "./voice/attach-connection-listeners.js";
import { createResumeHandleSync, type ResumeHandleSync } from "./voice/resume-handle-sync.js";

/**
 * Gemini Live emits sessionResumptionUpdate very frequently.
 * Debounce PUT /voice/resume-handle so CF only sees quiet-period updates;
 * always flush on disconnect / suspend.
 */
export const RESUME_HANDLE_DEBOUNCE_MS = 2_000;

export type UseVoiceSessionOptions = {
  /**
   * Inject a VoiceProvider (tests: FakeVoiceProvider).
   * Default: {@link GeminiLiveVoiceProvider}.
   */
  provider?: VoiceProvider;
  /**
   * Capture microphone + play model audio in the browser after connect.
   * Default: true when `navigator.mediaDevices` exists (skipped in unit tests).
   */
  enableBrowserMedia?: boolean;
  /**
   * Optional text turn after media is ready (forces a model response).
   * Default: omitted — pure mic audio is lower latency for Live conversations.
   */
  openingText?: string;
};

export type UseVoiceSessionResult = {
  status: VoiceSessionStatus | "idle";
  lease: VoiceLease | null;
  error: Error | null;
  transcript: VoiceTranscriptEntry[];
  /** Acquire lease, mint token, open Voice connection. Does not start Execution Session. */
  connect: (input?: { continuationId?: string }) => Promise<void>;
  /** Persist a Continuation checkpoint, then close Voice while Execution continues. */
  suspend: (input: {
    id?: string;
    wakeCondition: ContinuationWakeCondition;
    suspendedReason: string;
    resumeDirective: string;
  }) => Promise<ExecutionContinuation>;
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
  const clientRef = useRef(client);
  const enableBrowserMediaRef = useRef(options.enableBrowserMedia);
  const openingTextRef = useRef(options.openingText);
  /** Prop-facing session id (for connect / refetch). */
  const sessionIdRef = useRef(sessionId);

  // Sync latest props into refs after commit — never during render.
  useLayoutEffect(() => {
    if (options.provider) {
      providerRef.current = options.provider;
    }
    clientRef.current = client;
    enableBrowserMediaRef.current = options.enableBrowserMedia;
    openingTextRef.current = options.openingText;
    sessionIdRef.current = sessionId;
  }, [client, options.provider, options.enableBrowserMedia, options.openingText, sessionId]);

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

  /** One state blob so session-reset is a single setState (no cascading setState). */
  type VoiceView = {
    status: VoiceSessionStatus | "idle";
    lease: VoiceLease | null;
    error: Error | null;
    transcript: VoiceTranscriptEntry[];
    connection: VoiceConnection | null;
  };
  const [view, setView] = useState<VoiceView>({
    status: "idle",
    lease: null,
    error: null,
    transcript: [],
    connection: null,
  });
  const { status, lease, error, transcript, connection } = view;
  const setStatus = useCallback(
    (status: VoiceSessionStatus | "idle") => setView((v) => ({ ...v, status })),
    [],
  );
  const setLease = useCallback((lease: VoiceLease | null) => setView((v) => ({ ...v, lease })), []);
  const setError = useCallback((error: Error | null) => setView((v) => ({ ...v, error })), []);
  const setConnection = useCallback(
    (connection: VoiceConnection | null) => setView((v) => ({ ...v, connection })),
    [],
  );
  const appendTranscriptEntry = useCallback((entry: VoiceTranscriptEntry) => {
    setView((v) => ({
      ...v,
      transcript: [...v.transcript, entry].slice(-40),
    }));
  }, []);

  const connectionRef = useRef<VoiceConnection | null>(null);
  const mediaRef = useRef<BrowserVoiceMediaHandle | null>(null);
  const unsubscribersRef = useRef<Array<() => void>>([]);
  /** Serializes tool-call batches. Initialized on first use (not during render). */
  const toolQueueRef = useRef<Promise<void> | undefined>(undefined);
  const disconnectingRef = useRef(false);
  const connectingRef = useRef(false);
  const resumeSyncRef = useRef<ResumeHandleSync | null>(null);
  const bindMetaRef = useRef<{ sid: string; epoch: number } | null>(null);

  const stopBrowserMedia = useCallback(() => {
    mediaRef.current?.stop();
    mediaRef.current = null;
  }, []);

  const isCurrent = useCallback((epoch: number) => epochRef.current === epoch, []);

  /** One sync controller for the currently bound voice session. */
  const ensureResumeSync = useCallback(
    (sid: string, epoch: number): ResumeHandleSync => {
      resumeSyncRef.current?.dispose();
      const sync = createResumeHandleSync({
        debounceMs: RESUME_HANDLE_DEBOUNCE_MS,
        put: async (handle) => {
          const nextLease = await clientRef.current.setVoiceResumeHandle(sid, handle);
          if (!isCurrent(epoch) || boundSessionIdRef.current !== sid) return;
          setLease(nextLease);
        },
        onOptimistic: (handle) => {
          if (!isCurrent(epoch)) return;
          setView((v) =>
            v.lease && v.lease.providerResumeHandle !== handle
              ? { ...v, lease: { ...v.lease, providerResumeHandle: handle } }
              : v,
          );
        },
        isCurrent: () => isCurrent(epoch) && boundSessionIdRef.current === sid,
      });
      resumeSyncRef.current = sync;
      return sync;
    },
    [isCurrent],
  );

  const clearSubscriptions = useCallback(() => {
    for (const unsub of unsubscribersRef.current) {
      unsub();
    }
    unsubscribersRef.current = [];
  }, []);

  const appendTranscript = appendTranscriptEntry;

  const handleToolCalls = useCallback(
    async (sid: string, conn: VoiceConnection, calls: VoiceToolCall[], epoch: number) => {
      if (!isCurrent(epoch)) return;
      const responses = await Promise.all(
        calls.map(async (call) => {
          appendTranscript({ role: "tool", text: `tool: ${call.name}` });
          try {
            const result = await clientRef.current.executeVoiceTool(sid, {
              toolName: call.name,
              args: call.args,
              callId: call.id,
            });
            if (result.ok) {
              return {
                id: call.id,
                name: call.name,
                response: { result: result.result ?? null },
              };
            }
            return {
              id: call.id,
              name: call.name,
              response: {
                error: true as const,
                message: result.message ?? `Tool failed: ${call.name}`,
              },
            };
          } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            return {
              id: call.id,
              name: call.name,
              response: { error: true as const, message },
            };
          }
        }),
      );
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
      bindMetaRef.current = { sid, epoch };
      if (!isCurrent(epoch)) return;
      setView((v) => ({ ...v, connection: conn, status: conn.status }));
    },
    [clearSubscriptions, isCurrent],
  );

  // Lifecycle-owned subscriptions (cleanup on connection change / unmount).
  // Registration lives in attachVoiceConnectionListeners so the effect returns a clear unsub.
  useEffect(() => {
    const conn = connection;
    const meta = bindMetaRef.current;
    if (!conn || !meta) {
      return;
    }
    const { sid, epoch } = meta;

    const unsubscribe = attachVoiceConnectionListeners(conn, {
      onStatus: (next) => {
        if (!isCurrent(epoch)) return;
        setStatus(next);
      },
      onError: (err) => {
        if (!isCurrent(epoch)) return;
        setView((v) => ({ ...v, error: err, status: "error" }));
      },
      onTranscript: (entry) => {
        if (!isCurrent(epoch)) return;
        appendTranscript(entry);
      },
      onResumeHandle: (handle) => {
        resumeSyncRef.current?.schedule(handle);
      },
      onToolCall: (calls) => {
        const queue = toolQueueRef.current ?? Promise.resolve();
        toolQueueRef.current = queue
          .catch(() => undefined)
          .then(() => handleToolCalls(sid, conn, calls, epoch))
          .catch((caught) => {
            if (!isCurrent(epoch)) return;
            const next = caught instanceof Error ? caught : new Error(String(caught));
            setError(next);
          });
      },
    });
    unsubscribersRef.current = [unsubscribe];
    return unsubscribe;
  }, [connection, appendTranscript, handleToolCalls, isCurrent, setStatus, setError]);

  const disconnect = useCallback(async () => {
    if (disconnectingRef.current) return;
    disconnectingRef.current = true;
    const epoch = epochRef.current;
    // Always release the session that holds the connection, not the latest prop.
    const sid = boundSessionIdRef.current;
    try {
      stopBrowserMedia();
      clearSubscriptions();
      // Persist latest Live resumption handle before releasing the lease.
      if (sid) {
        await resumeSyncRef.current?.flush();
      }
      resumeSyncRef.current?.dispose();
      resumeSyncRef.current = null;
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
        setView((v) => ({
          ...v,
          status: "disconnected",
          connection: null,
          transcript: [
            ...v.transcript,
            { role: "status" as const, text: "Voice disconnected (session continues)." },
          ].slice(-40),
        }));
      }
    } finally {
      disconnectingRef.current = false;
    }
  }, [clearSubscriptions, isCurrent, stopBrowserMedia]);

  const connect = useCallback(
    async (input: { continuationId?: string } = {}) => {
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
        setView((v) => ({
          ...v,
          error: null,
          status: "connecting",
          transcript: [
            ...v.transcript,
            { role: "status" as const, text: "Connecting voice…" },
          ].slice(-40),
        }));
      }

      let claimedContinuationId: string | null = null;
      let claimedAttemptId: string | null = null;
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
        const resumeSync = ensureResumeSync(sid, epoch);
        resumeSync.noteKnown(acquired.providerResumeHandle ?? null);

        const resume = input.continuationId
          ? await clientRef.current.claimContinuationResume(sid, input.continuationId)
          : null;
        claimedContinuationId = resume?.continuation.id ?? null;
        claimedAttemptId = resume?.continuation.resumeAttemptId ?? null;
        if (!isCurrent(epoch)) throw new Error("Voice connection superseded");

        let minted = await clientRef.current.mintVoiceToken(sid);
        if (!isCurrent(epoch)) {
          throw new Error("Voice connection superseded");
        }

        const resumeHandle =
          resume?.continuation.providerResumeHandle ?? acquired.providerResumeHandle;
        let conn: VoiceConnection;
        try {
          conn = await providerRef.current.connect({
            credentials: { token: minted.token, model: minted.model },
            resumeHandle,
          });
        } catch (caught) {
          if (!resumeHandle) throw caught;
          // Provider handles are advisory. Clear the stale handle, mint a token
          // without resumption constraints, and reconnect as a new Voice Session.
          await resumeSync.clearRemote();
          minted = await clientRef.current.mintVoiceToken(sid);
          conn = await providerRef.current.connect({
            credentials: { token: minted.token, model: minted.model },
            resumeHandle: null,
          });
        }
        if (!isCurrent(epoch)) {
          await conn.disconnect();
          throw new Error("Voice connection superseded");
        }

        // Media before completeContinuation so a failed mic does not leave a completed resume.
        bindConnection(sid, conn, epoch);

        const enableMedia =
          enableBrowserMediaRef.current ??
          (typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia));
        if (enableMedia) {
          stopBrowserMedia();
          try {
            mediaRef.current = await attachBrowserVoiceMedia(conn, {
              onError: (mediaError) => {
                if (!isCurrent(epoch)) return;
                setError(mediaError);
              },
            });
          } catch (mediaCaught) {
            const mediaError =
              mediaCaught instanceof Error ? mediaCaught : new Error(String(mediaCaught));
            await conn.disconnect();
            throw new Error(
              `Microphone failed: ${mediaError.message}. Allow mic permission and reconnect.`,
            );
          }
          if (!isCurrent(epoch)) {
            stopBrowserMedia();
            await conn.disconnect();
            throw new Error("Voice connection superseded");
          }
          appendTranscript({
            role: "status",
            text: "Microphone on — speak to the assistant.",
          });
        }

        if (resume) {
          const attemptId = resume.continuation.resumeAttemptId;
          if (!attemptId) throw new Error("Claimed continuation has no resume attempt id");
          try {
            await clientRef.current.completeContinuation(sid, resume.continuation.id, attemptId);
            claimedContinuationId = null;
            claimedAttemptId = null;
          } catch (caught) {
            stopBrowserMedia();
            await conn.disconnect();
            throw caught;
          }
        }

        // Optional text kickstart when host sets openingText.
        const opening = openingTextRef.current;
        if (opening && conn.sendText) {
          try {
            conn.sendText(opening);
            appendTranscript({ role: "user", text: opening });
          } catch {
            // optional kickstart
          }
        }

        appendTranscript({ role: "status", text: "Voice connected." });
      } catch (caught) {
        stopBrowserMedia();
        const next = caught instanceof Error ? caught : new Error(String(caught));
        if (claimedContinuationId) {
          try {
            if (claimedAttemptId) {
              await clientRef.current.failContinuationResume(
                sid,
                claimedContinuationId,
                claimedAttemptId,
              );
            }
          } catch {
            // Preserve the original connection error. Durable state can still
            // be recovered by a later server-side stale-claim policy.
          }
        }
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
          setView((v) => ({
            ...v,
            error: next,
            status: "error",
            lease: null,
          }));
        }
        throw next;
      } finally {
        if (isCurrent(epoch)) {
          connectingRef.current = false;
        }
      }
    },
    [appendTranscript, bindConnection, disconnect, ensureResumeSync, isCurrent, stopBrowserMedia],
  );

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
      if (next) {
        resumeSyncRef.current?.noteKnown(next.providerResumeHandle ?? null);
      }
    }
  }, [isCurrent]);

  const suspend = useCallback(
    async (input: {
      id?: string;
      wakeCondition: ContinuationWakeCondition;
      suspendedReason: string;
      resumeDirective: string;
    }): Promise<ExecutionContinuation> => {
      const sid = sessionIdRef.current;
      if (!sid) throw new Error("sessionId is required to suspend voice");
      // Continuation checkpoint should capture the latest Live handle.
      await resumeSyncRef.current?.flush();
      const continuation = await clientRef.current.suspendContinuation(sid, input);
      await disconnect();
      return continuation;
    },
    [disconnect],
  );

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
    setView({
      status: "idle",
      lease: null,
      error: null,
      transcript: [],
      connection: null,
    });

    return () => {
      epochRef.current += 1;
      // disconnect flushes then disposes resume-handle sync; do not dispose first
      // or a handle still in the debounce window is dropped on unmount/session switch.
      void disconnect();
    };
  }, [sessionId, disconnect]);

  return {
    status: sessionId ? status : "idle",
    lease,
    error,
    transcript,
    connect,
    suspend,
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
