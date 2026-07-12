import { z } from "zod";

import { dateSchema } from "./date.js";

/** Voice Session connection lifecycle (ephemeral; not Execution Session status). */
export const voiceSessionStatusSchema = z.enum([
  "disconnected",
  "connecting",
  "connected",
  "muted",
  "recovering",
  "error",
]);
export type VoiceSessionStatus = z.infer<typeof voiceSessionStatusSchema>;

export const voiceLeaseStatusSchema = z.enum(["active", "released", "expired"]);
export type VoiceLeaseStatus = z.infer<typeof voiceLeaseStatusSchema>;

/**
 * Exclusive connection right for one Execution Session.
 * At most one `active` lease per sessionId (enforced by storage uniqueness).
 */
export const voiceLeaseSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  actorId: z.string().min(1),
  status: voiceLeaseStatusSchema,
  acquiredAt: dateSchema,
  expiresAt: dateSchema,
  /** Opaque Gemini (or other) session resumption handle; not a chat history substitute. */
  providerResumeHandle: z.string().nullable(),
});
export type VoiceLease = z.infer<typeof voiceLeaseSchema>;

export const DEFAULT_VOICE_LEASE_TTL_MS = 30 * 60 * 1000;

export type CreateVoiceLeaseInput = {
  id: string;
  sessionId: string;
  actorId: string;
  acquiredAt?: Date;
  /** Defaults to {@link DEFAULT_VOICE_LEASE_TTL_MS} after acquiredAt. */
  ttlMs?: number;
  expiresAt?: Date;
  providerResumeHandle?: string | null;
};

export function createVoiceLease(input: CreateVoiceLeaseInput): VoiceLease {
  const acquiredAt = input.acquiredAt ?? new Date();
  const expiresAt =
    input.expiresAt ?? new Date(acquiredAt.getTime() + (input.ttlMs ?? DEFAULT_VOICE_LEASE_TTL_MS));

  return voiceLeaseSchema.parse({
    id: input.id,
    sessionId: input.sessionId,
    actorId: input.actorId,
    status: "active",
    acquiredAt,
    expiresAt,
    providerResumeHandle: input.providerResumeHandle ?? null,
  });
}

export function isVoiceLeaseActive(lease: VoiceLease, now: Date = new Date()): boolean {
  return lease.status === "active" && lease.expiresAt.getTime() > now.getTime();
}

export function expireVoiceLease(lease: VoiceLease, now: Date = new Date()): VoiceLease {
  if (lease.status !== "active") return lease;
  if (lease.expiresAt.getTime() > now.getTime()) return lease;
  return { ...lease, status: "expired" };
}

export function releaseVoiceLease(lease: VoiceLease): VoiceLease {
  if (lease.status !== "active") return lease;
  return { ...lease, status: "released" };
}

/** Tool call emitted by a Voice Provider (LLM function call). */
export type VoiceToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type VoiceToolResponse = {
  id: string;
  name: string;
  response: Record<string, unknown>;
};

export type VoiceTranscriptEntry = {
  role: "user" | "assistant" | "status" | "tool";
  text: string;
};

/**
 * Connection credentials for a VoiceProvider.
 * Live system instructions / tools stay server-locked on the ephemeral token;
 * clients only receive short-lived credentials + model id.
 */
export type VoiceConnectOptions = {
  credentials: {
    token: string;
    model?: string;
  };
  /** Provider resume handle from a prior connection, when available. */
  resumeHandle?: string | null;
};

export type VoiceConnectionEventMap = {
  status: VoiceSessionStatus;
  audio: Uint8Array;
  transcript: VoiceTranscriptEntry;
  toolCall: VoiceToolCall[];
  error: Error;
  resumeHandle: string;
  /** Model interrupted playback (user barge-in); clients should flush audio queues. */
  interrupted: true;
};

export type VoiceConnectionEvent = keyof VoiceConnectionEventMap;

export interface VoiceConnection {
  readonly status: VoiceSessionStatus;
  sendAudio(chunk: ArrayBuffer | Uint8Array): void;
  sendText?(text: string): void;
  sendToolResponse(responses: VoiceToolResponse[]): void;
  mute(): void;
  unmute(): void;
  disconnect(): Promise<void>;
  on<E extends VoiceConnectionEvent>(
    event: E,
    handler: (payload: VoiceConnectionEventMap[E]) => void,
  ): () => void;
}

export interface VoiceProvider {
  connect(options: VoiceConnectOptions): Promise<VoiceConnection>;
}

type HandlerMap = {
  [E in VoiceConnectionEvent]: Set<(payload: VoiceConnectionEventMap[E]) => void>;
};

/** Shared typed event bus for VoiceConnection implementations. */
export type VoiceEventBus = {
  on<E extends VoiceConnectionEvent>(
    event: E,
    handler: (payload: VoiceConnectionEventMap[E]) => void,
  ): () => void;
  emit<E extends VoiceConnectionEvent>(event: E, payload: VoiceConnectionEventMap[E]): void;
};

export function createVoiceEventBus(): VoiceEventBus {
  const handlers: HandlerMap = {
    status: new Set(),
    audio: new Set(),
    transcript: new Set(),
    toolCall: new Set(),
    error: new Set(),
    resumeHandle: new Set(),
    interrupted: new Set(),
  };

  return {
    on(event, handler) {
      const set = handlers[event] as Set<(payload: VoiceConnectionEventMap[typeof event]) => void>;
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    emit(event, payload) {
      const set = handlers[event] as Set<(payload: VoiceConnectionEventMap[typeof event]) => void>;
      for (const handler of set) {
        handler(payload);
      }
    },
  };
}

/**
 * In-memory Voice Provider for unit tests.
 * Does not open network sockets; tests drive tool calls via {@link FakeVoiceConnection.emitToolCalls}.
 */
export class FakeVoiceProvider implements VoiceProvider {
  readonly connections: FakeVoiceConnection[] = [];

  async connect(options: VoiceConnectOptions): Promise<VoiceConnection> {
    const connection = new FakeVoiceConnection(options);
    this.connections.push(connection);
    connection.markConnected();
    return connection;
  }
}

export class FakeVoiceConnection implements VoiceConnection {
  status: VoiceSessionStatus = "connecting";
  readonly sentAudio: Uint8Array[] = [];
  readonly sentText: string[] = [];
  readonly toolResponses: VoiceToolResponse[] = [];
  private readonly bus = createVoiceEventBus();

  constructor(readonly options: VoiceConnectOptions) {}

  markConnected(): void {
    this.setStatus("connected");
  }

  sendAudio(chunk: ArrayBuffer | Uint8Array): void {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.sentAudio.push(bytes);
  }

  sendText(text: string): void {
    this.sentText.push(text);
  }

  sendToolResponse(responses: VoiceToolResponse[]): void {
    this.toolResponses.push(...responses);
  }

  mute(): void {
    if (this.status === "connected") this.setStatus("muted");
  }

  unmute(): void {
    if (this.status === "muted") this.setStatus("connected");
  }

  async disconnect(): Promise<void> {
    this.setStatus("disconnected");
  }

  on<E extends VoiceConnectionEvent>(
    event: E,
    handler: (payload: VoiceConnectionEventMap[E]) => void,
  ): () => void {
    return this.bus.on(event, handler);
  }

  /** Test helper: simulate model tool calls. */
  emitToolCalls(calls: VoiceToolCall[]): void {
    this.bus.emit("toolCall", calls);
  }

  emitTranscript(entry: VoiceTranscriptEntry): void {
    this.bus.emit("transcript", entry);
  }

  emitAudio(chunk: Uint8Array): void {
    this.bus.emit("audio", chunk);
  }

  emitResumeHandle(handle: string): void {
    this.bus.emit("resumeHandle", handle);
  }

  emitError(error: Error): void {
    this.setStatus("error");
    this.bus.emit("error", error);
  }

  private setStatus(status: VoiceSessionStatus): void {
    this.status = status;
    this.bus.emit("status", status);
  }
}
