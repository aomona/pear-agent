import type { RuntimeSnapshot } from "@pear-agent/core";

import type { PearClient } from "./client.js";
import { PEAR_CONTEXT_QUERY_KEY, serializePearClientContext } from "./context-wire.js";
import { parseSyncState } from "./parse.js";
import type { ConnectionStatus, ExecutionContinuationStub, PearClientContext } from "./types.js";

export type SessionChannelOptions = {
  recentEventLimit?: number;
  realtime: boolean;
  agentName: string;
  agentSecure: boolean;
  baseUrl: string;
  getContext: () => PearClientContext | Promise<PearClientContext>;
};

export type SessionChannelSnapshot = {
  snapshot: RuntimeSnapshot | null;
  continuation: ExecutionContinuationStub | null;
  revision: number;
  lastEventId: string | null;
  status: ConnectionStatus;
  error: Error | null;
};

type Listener = () => void;

type ChannelKey = string;

type AgentSocket = {
  close: () => void;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
};

/** Stable identity for PearClient instances so channels never cross clients. */
const clientIds = new WeakMap<PearClient, number>();
let nextClientId = 0;

function clientKey(client: PearClient): number {
  let id = clientIds.get(client);
  if (id === undefined) {
    id = ++nextClientId;
    clientIds.set(client, id);
  }
  return id;
}

function hostFromBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

function channelKey(
  sessionId: string,
  client: PearClient,
  options: SessionChannelOptions,
): ChannelKey {
  return [
    clientKey(client),
    sessionId,
    options.realtime ? "rt" : "http",
    options.recentEventLimit ?? "default",
    options.agentName,
    options.agentSecure ? "s" : "i",
    options.baseUrl,
  ].join("|");
}

/**
 * Shared per-session subscription so multiple hooks (snapshot + continuation)
 * share one HTTP hydrate and one Agent WebSocket.
 *
 * Realtime path: Agent broadcasts an invalidation pulse (`revision` /
 * `lastEventId`). Snapshots always come from HTTP — never from Agent state.
 */
export class SessionChannel {
  private readonly listeners = new Set<Listener>();
  private refCount = 0;
  private state: SessionChannelSnapshot = {
    snapshot: null,
    continuation: null,
    revision: 0,
    lastEventId: null,
    status: "loading",
    error: null,
  };
  private lastRevision = 0;
  private hydrateGeneration = 0;
  private stopAgent: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly sessionId: string,
    private readonly client: PearClient,
    private readonly options: SessionChannelOptions,
  ) {
    void this.hydrateHttp();
    if (options.realtime) {
      this.startAgent();
    }
  }

  retain(): void {
    this.refCount += 1;
  }

  release(): boolean {
    this.refCount -= 1;
    return this.refCount <= 0;
  }

  getSnapshot(): SessionChannelSnapshot {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async refetch(): Promise<void> {
    await this.hydrateHttp();
  }

  dispose(): void {
    this.disposed = true;
    this.stopAgent?.();
    this.stopAgent = null;
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setState(partial: Partial<SessionChannelSnapshot>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  /** Apply Agent invalidation pulse; snapshot content always comes from HTTP. */
  private applyPulse(raw: unknown): void {
    try {
      const parsed = parseSyncState(raw);
      if (parsed.revision < this.lastRevision) {
        return;
      }

      const advanced = parsed.revision > this.lastRevision;
      this.lastRevision = parsed.revision;
      this.setState({
        revision: parsed.revision,
        lastEventId: parsed.lastEventId,
        continuation: parsed.continuation,
        status: this.state.status === "loading" ? "loading" : "connected",
        error: null,
      });

      // Revision advanced → re-fetch durable snapshot over HTTP.
      if (advanced && parsed.revision > 0) {
        void this.hydrateHttp();
      }
    } catch (caught) {
      const next = caught instanceof Error ? caught : new Error(String(caught));
      this.setState({ error: next, status: "error" });
    }
  }

  private async hydrateHttp(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.hydrateGeneration;
    if (this.state.status !== "connected" && this.state.status !== "reconnecting") {
      this.setState({ status: "loading", error: null });
    }

    try {
      const next = await this.client.getSnapshot(
        this.sessionId,
        this.options.recentEventLimit === undefined
          ? undefined
          : { recentEventLimit: this.options.recentEventLimit },
      );
      if (this.disposed || generation !== this.hydrateGeneration) return;
      this.setState({
        snapshot: next,
        continuation: next.continuation,
        status: "connected",
        error: null,
      });
    } catch (caught) {
      if (this.disposed || generation !== this.hydrateGeneration) return;
      const nextErr = caught instanceof Error ? caught : new Error(String(caught));
      this.setState({ error: nextErr, status: "error" });
    }
  }

  private startAgent(): void {
    let closed = false;
    let agentClient: AgentSocket | null = null;

    void import("agents/client")
      .then(({ AgentClient }) => {
        if (closed || this.disposed) return;

        const client = new AgentClient({
          agent: this.options.agentName,
          name: this.sessionId,
          host: hostFromBaseUrl(this.options.baseUrl),
          protocol: this.options.agentSecure ? "wss" : "ws",
          query: async () => {
            const context = await this.options.getContext();
            return {
              [PEAR_CONTEXT_QUERY_KEY]: serializePearClientContext(context),
            };
          },
          onStateUpdate: (state: unknown) => {
            if (closed || this.disposed) return;
            this.applyPulse(state);
          },
          onConnectionError: (connectionError: Error) => {
            if (closed || this.disposed) return;
            this.setState({ error: connectionError, status: "error" });
          },
        }) as AgentSocket;

        // Assign immediately so cleanup cannot race past construction.
        agentClient = client;

        const onOpen = () => {
          if (closed || this.disposed) return;
          this.setState({ status: "connected" });
          // Reconnect convergence: always re-fetch durable snapshot.
          void this.hydrateHttp();
        };
        const onClose = () => {
          if (closed || this.disposed) return;
          this.setState({ status: "reconnecting" });
        };
        const onError = () => {
          if (closed || this.disposed) return;
          this.setState({ status: "reconnecting" });
        };

        client.addEventListener("open", onOpen);
        client.addEventListener("close", onClose);
        client.addEventListener("error", onError);
      })
      .catch((caught: unknown) => {
        if (closed || this.disposed) return;
        const nextErr =
          caught instanceof Error
            ? caught
            : new Error("Failed to load agents/client for realtime sync");
        this.setState({ error: nextErr, status: "error" });
      });

    this.stopAgent = () => {
      closed = true;
      agentClient?.close();
      agentClient = null;
    };
  }
}

const channels = new Map<ChannelKey, SessionChannel>();

export type AcquireSessionChannelResult = {
  channel: SessionChannel;
  release: () => void;
};

/**
 * Acquire a shared channel for a session. Call `release` when the consumer unmounts.
 * The underlying connection is torn down when the last consumer releases.
 *
 * Channels are keyed by PearClient instance identity so two providers/clients
 * never silently share auth or fetch implementations.
 */
export function acquireSessionChannel(
  sessionId: string,
  client: PearClient,
  options: SessionChannelOptions,
): AcquireSessionChannelResult {
  const key = channelKey(sessionId, client, options);
  let channel = channels.get(key);
  if (!channel) {
    channel = new SessionChannel(sessionId, client, options);
    channels.set(key, channel);
  }
  channel.retain();

  let released = false;
  return {
    channel,
    release: () => {
      if (released) return;
      released = true;
      // Defer so React strict-mode re-subscribe in the same tick can retain again.
      queueMicrotask(() => {
        if (!channel.release()) return;
        if (channels.get(key) !== channel) return;
        channel.dispose();
        channels.delete(key);
      });
    },
  };
}

/** Test helper: drop all shared channels. */
export function __resetSessionChannelsForTests(): void {
  for (const channel of channels.values()) {
    channel.dispose();
  }
  channels.clear();
}
