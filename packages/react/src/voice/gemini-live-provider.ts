import {
  createVoiceEventBus,
  type VoiceConnectOptions,
  type VoiceConnection,
  type VoiceConnectionEvent,
  type VoiceConnectionEventMap,
  type VoiceProvider,
  type VoiceSessionStatus,
  type VoiceToolResponse,
} from "@pear-agent/core";

type LiveSessionLike = {
  close: () => void;
  sendRealtimeInput?: (input: { audio: { data: string; mimeType: string } }) => void;
  sendClientContent?: (input: unknown) => void;
  sendToolResponse?: (input: { functionResponses: unknown[] }) => void;
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
 * Credentials must be short-lived ephemeral tokens from the PEAR Worker.
 * System instructions / tools are locked into the token server-side.
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
    const model = this.options.credentials.model ?? "gemini-2.5-flash-native-audio-preview-12-2025";
    const ai = new this.GoogleGenAI({
      apiKey: this.options.credentials.token,
      httpOptions: { apiVersion: "v1alpha" },
    });

    // Config is locked in the ephemeral token; only sessionResumption handle is client-side.
    const config: Record<string, unknown> = {
      responseModalities: ["AUDIO"],
      sessionResumption: this.options.resumeHandle ? { handle: this.options.resumeHandle } : {},
    };

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
    const data = bytesToBase64(bytes);
    this.session.sendRealtimeInput({
      audio: { data, mimeType: "audio/pcm;rate=16000" },
    });
  }

  sendText(text: string): void {
    if (!this.session?.sendClientContent) return;
    this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    });
  }

  sendToolResponse(responses: VoiceToolResponse[]): void {
    if (!this.session?.sendToolResponse) return;
    this.session.sendToolResponse({
      functionResponses: responses.map((r) => ({
        id: r.id,
        name: r.name,
        response: r.response,
      })),
    });
  }

  mute(): void {
    this.muted = true;
    if (this.status === "connected") this.setStatus("muted");
  }

  unmute(): void {
    this.muted = false;
    if (this.status === "muted") this.setStatus("connected");
  }

  async disconnect(): Promise<void> {
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

    const serverContent = message.serverContent as
      | {
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          modelTurn?: { parts?: { inlineData?: { data?: string } }[] };
        }
      | undefined;

    if (serverContent?.inputTranscription?.text) {
      this.bus.emit("transcript", {
        role: "user",
        text: serverContent.inputTranscription.text,
      });
    }
    if (serverContent?.outputTranscription?.text) {
      this.bus.emit("transcript", {
        role: "assistant",
        text: serverContent.outputTranscription.text,
      });
    }

    for (const part of serverContent?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        try {
          this.bus.emit("audio", base64ToBytes(part.inlineData.data));
        } catch {
          // ignore decode errors
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
