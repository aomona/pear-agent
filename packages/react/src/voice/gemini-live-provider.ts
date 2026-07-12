import {
  createVoiceEventBus,
  DEFAULT_GEMINI_LIVE_MODEL,
  type VoiceConnectOptions,
  type VoiceConnection,
  type VoiceConnectionEvent,
  type VoiceConnectionEventMap,
  type VoiceProvider,
  type VoiceSessionStatus,
  type VoiceToolResponse,
} from "@pear-agent/core";

/** Subset of @google/genai Live session used by this provider. */
type LiveSessionLike = {
  close: () => void;
  /**
   * Real-time user input (audio / video / text / stream control).
   * Per gemini-live-api-dev: use this for ALL conversational input.
   * Do not use `media` — use specific keys: audio, video, text, audioStreamEnd.
   */
  sendRealtimeInput?: (input: Record<string, unknown>) => void;
};

type GenAiCtor = new (opts: { apiKey: string; httpOptions?: { apiVersion: string } }) => {
  live: {
    connect: (args: {
      model: string;
      config: Record<string, unknown>;
      callbacks: {
        onopen?: () => void;
        onmessage?: (message: Record<string, unknown>) => void;
        onerror?: (error: { message?: string }) => void;
        onclose?: () => void;
      };
    }) => Promise<LiveSessionLike>;
  };
};

/**
 * Gemini Live VoiceProvider using `@google/genai` (browser / client-to-server).
 *
 * Follows gemini-live-api-dev:
 * - Model: gemini-3.1-flash-live-preview
 * - Ephemeral tokens only (never long-lived API keys in the browser)
 * - sendRealtimeInput for audio and text
 * - audioStreamEnd when the mic is paused
 * - Clear playback on serverContent.interrupted
 * - Process every part of each server event
 */
export class GeminiLiveVoiceProvider implements VoiceProvider {
  async connect(options: VoiceConnectOptions): Promise<VoiceConnection> {
    const { GoogleGenAI } = await import("@google/genai");
    const connection = new GeminiLiveVoiceConnection(options, GoogleGenAI as unknown as GenAiCtor);
    await connection.open();
    return connection;
  }
}

class GeminiLiveVoiceConnection implements VoiceConnection {
  status: VoiceSessionStatus = "connecting";
  private session: LiveSessionLike | null = null;
  private muted = false;
  private readonly bus = createVoiceEventBus();

  constructor(
    private readonly options: VoiceConnectOptions,
    private readonly GoogleGenAI: GenAiCtor,
  ) {}

  async open(): Promise<void> {
    this.setStatus("connecting");
    const model = this.options.credentials.model ?? DEFAULT_GEMINI_LIVE_MODEL;

    // Ephemeral token acts as the API key (v1alpha Live only).
    const ai = new this.GoogleGenAI({
      apiKey: this.options.credentials.token,
      httpOptions: { apiVersion: "v1alpha" },
    });

    // System instruction / tools / modalities are locked into the ephemeral token
    // server-side. Client only supplies session resumption when reconnecting.
    const config: Record<string, unknown> = this.options.resumeHandle
      ? { sessionResumption: { handle: this.options.resumeHandle } }
      : {};

    this.session = await ai.live.connect({
      model,
      config,
      callbacks: {
        onopen: () => {
          this.setStatus(this.muted ? "muted" : "connected");
        },
        onmessage: (message: Record<string, unknown>) => {
          this.handleMessage(message);
        },
        onerror: (error: { message?: string }) => {
          const err = new Error(error.message ?? "Gemini Live connection error");
          this.setStatus("error");
          this.bus.emit("error", err);
        },
        onclose: () => {
          this.session = null;
          if (this.status !== "disconnected") {
            this.setStatus("disconnected");
          }
        },
      },
    });
  }

  sendAudio(chunk: ArrayBuffer | Uint8Array): void {
    if (!this.session?.sendRealtimeInput || this.muted || this.status === "disconnected") return;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.session.sendRealtimeInput({
      audio: {
        data: bytesToBase64(bytes),
        mimeType: "audio/pcm;rate=16000",
      },
    });
  }

  /**
   * Conversational text during a Live session (not history seeding).
   * Skill: use sendRealtimeInput({ text }) — not sendClientContent.
   */
  sendText(text: string): void {
    if (!this.session?.sendRealtimeInput || this.status === "disconnected") return;
    this.session.sendRealtimeInput({ text });
  }

  sendToolResponse(responses: VoiceToolResponse[]): void {
    if (!this.session) return;
    // Synchronous tool responses — Live tool use is sync only (skill).
    const session = this.session as LiveSessionLike & {
      sendToolResponse?: (input: { functionResponses: unknown[] }) => void;
    };
    if (!session.sendToolResponse) return;
    session.sendToolResponse({
      functionResponses: responses.map((r) => ({
        id: r.id,
        name: r.name,
        response: r.response,
      })),
    });
  }

  mute(): void {
    this.muted = true;
    // When the audio stream is paused, flush server-side cached audio (VAD).
    this.session?.sendRealtimeInput?.({ audioStreamEnd: true });
    if (this.status === "connected") this.setStatus("muted");
  }

  unmute(): void {
    this.muted = false;
    if (this.status === "muted") this.setStatus("connected");
  }

  async disconnect(): Promise<void> {
    try {
      if (this.session?.sendRealtimeInput) {
        this.session.sendRealtimeInput({ audioStreamEnd: true });
      }
    } catch {
      // ignore flush errors on teardown
    }
    this.session?.close();
    this.session = null;
    this.setStatus("disconnected");
  }

  on<E extends VoiceConnectionEvent>(
    event: E,
    handler: (payload: VoiceConnectionEventMap[E]) => void,
  ): () => void {
    return this.bus.on(event, handler);
  }

  private handleMessage(message: Record<string, unknown>): void {
    const resumption = message.sessionResumptionUpdate as
      | { resumable?: boolean; newHandle?: string }
      | undefined;
    if (resumption?.resumable && resumption.newHandle) {
      this.bus.emit("resumeHandle", resumption.newHandle);
    }

    // GoAway / session lifecycle signals (session management skill notes).
    if (message.goAway) {
      this.bus.emit("transcript", {
        role: "status",
        text: "Live session will close soon (GoAway) — prepare to reconnect.",
      });
    }

    const toolCall = message.toolCall as
      | { functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[] }
      | undefined;
    if (toolCall?.functionCalls?.length) {
      const calls = toolCall.functionCalls
        .filter((c): c is { id: string; name: string; args?: Record<string, unknown> } =>
          Boolean(c.id && c.name),
        )
        .map((c) => ({
          id: c.id,
          name: c.name,
          args: c.args ?? {},
        }));
      if (calls.length > 0) {
        this.bus.emit("toolCall", calls);
      }
    }

    // A single server event can contain multiple content parts at once —
    // always process ALL of them (audio + transcripts + interrupt).
    const serverContent = message.serverContent as
      | {
          interrupted?: boolean;
          turnComplete?: boolean;
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          modelTurn?: {
            parts?: {
              inlineData?: { data?: string; mimeType?: string };
              text?: string;
            }[];
          };
        }
      | undefined;

    if (!serverContent) return;

    if (serverContent.interrupted === true) {
      // Barge-in: stop playback and clear client audio queues.
      this.bus.emit("interrupted", true);
    }

    if (serverContent.inputTranscription?.text) {
      this.bus.emit("transcript", {
        role: "user",
        text: serverContent.inputTranscription.text,
      });
    }
    if (serverContent.outputTranscription?.text) {
      this.bus.emit("transcript", {
        role: "assistant",
        text: serverContent.outputTranscription.text,
      });
    }

    for (const part of serverContent.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        try {
          this.bus.emit("audio", base64ToBytes(part.inlineData.data));
        } catch {
          // ignore decode errors on individual parts
        }
      }
    }
  }

  private setStatus(status: VoiceSessionStatus): void {
    this.status = status;
    this.bus.emit("status", status);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
