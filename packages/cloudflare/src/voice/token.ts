import { DEFAULT_GEMINI_LIVE_MODEL, type RuntimeSnapshot, type VoiceLease } from "@pear-agent/core";

import { VoiceTokenUnavailableError } from "../errors.js";
import { listVoiceToolDeclarations, summarizeSnapshotForVoice } from "./tools.js";

export { DEFAULT_GEMINI_LIVE_MODEL };

/** Client-facing mint result — never includes system instructions / tool config. */
export type VoiceEphemeralTokenResult = {
  token: string;
  model: string;
};

export type MintVoiceTokenInput = {
  apiKey: string | undefined;
  snapshot: RuntimeSnapshot;
  lease: VoiceLease;
  model?: string;
  realtimeInstructions?: string;
  locale?: string;
};

/**
 * Port for Gemini Live ephemeral token minting.
 * Production uses {@link createGoogleGenaiTokenMinter}; tests inject a stub.
 */
export type VoiceTokenMinter = (input: MintVoiceTokenInput) => Promise<VoiceEphemeralTokenResult>;

/**
 * Server-only Live config locked into the ephemeral token (not returned to clients).
 * Aligns with gemini-live-api-dev + ephemeral token constraints.
 */
export function buildVoiceLiveConfig(input: {
  snapshot: RuntimeSnapshot;
  lease: VoiceLease;
  realtimeInstructions?: string;
  locale?: string;
}): Record<string, unknown> {
  const summary = summarizeSnapshotForVoice(input.snapshot);
  const tools = listVoiceToolDeclarations();
  const systemInstruction = [
    "You are a PEAR Runtime voice assistant helping the user execute a real-world plan.",
    `Respond in ${input.locale ?? "Japanese"} unless the user clearly uses another language.`,
    "Prefer short, concrete guidance focused on focusStepId / the active or ready step in steps[].",
    "Never claim a step, timer, or session state changed until the corresponding tool call succeeds.",
    "For every state-changing tool include confidence from 0 to 1. If confidence is below 0.8 or uncertain, ask the user and retry only after confirmation with confirmed=true.",
    "Use get_runtime_snapshot when state may have changed or when you are unsure.",
    "Plan timers live on steps[].timers (timerId + durationSeconds).",
    "If the user asks to start a charge/wait timer and a step has e.g. charge-wait, call start_timer with that timerId and durationSeconds immediately — do NOT ask how long when durationSeconds is already defined.",
    "When the user reports a plan-affecting domain change, call report_domain_event first, then request_replan. Never invent or apply a patch directly.",
    "Voice disconnect must never be treated as session cancellation; only call pause_session when the user asks to pause work.",
    ...(input.realtimeInstructions ? [`Domain instructions: ${input.realtimeInstructions}`] : []),
    "Current runtime summary JSON:",
    JSON.stringify(summary),
    ...(input.snapshot.continuation
      ? [
          `Resume reason: ${input.snapshot.continuation.suspendedReason}`,
          `Resume directive: ${input.snapshot.continuation.resumeDirective}`,
          "Confirm the current state briefly before giving the next instruction.",
        ]
      : []),
  ].join("\n");

  const sessionResumption: Record<string, unknown> = {};
  if (input.lease.providerResumeHandle) {
    sessionResumption.handle = input.lease.providerResumeHandle;
  }

  return {
    // Live sessions are AUDIO XOR TEXT — native audio uses AUDIO only.
    responseModalities: ["AUDIO"],
    // Bidirectional transcription for UI + quality (Live guide).
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: "Kore" },
      },
    },
    // Gemini 3.1 Live: thinkingLevel (not thinkingBudget). minimal = lowest latency.
    thinkingConfig: {
      thinkingLevel: "minimal",
    },
    // Automatic VAD is on by default; keep defaults for natural barge-in.
    // Client must send audioStreamEnd when the mic is paused (mute).
    sessionResumption,
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    tools: [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ],
  };
}

/** Stub minter for tests / environments without a real Gemini call. */
export const stubVoiceTokenMinter: VoiceTokenMinter = async (input) => {
  if (!input.apiKey) {
    throw new VoiceTokenUnavailableError("GEMINI_API_KEY is not configured");
  }
  return {
    token: `stub-token-${input.lease.id}`,
    model: input.model ?? DEFAULT_GEMINI_LIVE_MODEL,
  };
};

/**
 * Create a minter that calls `@google/genai` authTokens.create when available.
 * Live config is locked into the token server-side and not returned to clients
 * (ephemeral token best practice — never ship systemInstruction/tools to browser).
 */
export function createGoogleGenaiTokenMinter(): VoiceTokenMinter {
  return async (input) => {
    if (!input.apiKey) {
      throw new VoiceTokenUnavailableError("GEMINI_API_KEY is not configured");
    }
    const model = input.model ?? DEFAULT_GEMINI_LIVE_MODEL;
    const config = buildVoiceLiveConfig(input);

    try {
      const { GoogleGenAI } = await import("@google/genai");
      const client = new GoogleGenAI({
        apiKey: input.apiKey,
        httpOptions: { apiVersion: "v1alpha" },
      });
      const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const token = await client.authTokens.create({
        config: {
          uses: 1,
          expireTime,
          newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
          liveConnectConstraints: {
            model,
            config,
          },
          httpOptions: { apiVersion: "v1alpha" },
        },
      });
      const name = token.name;
      if (!name) {
        throw new VoiceTokenUnavailableError("Gemini authTokens.create returned no token name");
      }
      return { token: name, model };
    } catch (caught) {
      if (caught instanceof VoiceTokenUnavailableError) throw caught;
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.includes("Cannot find module") || message.includes("Failed to resolve")) {
        throw new VoiceTokenUnavailableError(
          "@google/genai is not installed; add it to the Worker dependencies for live token minting",
        );
      }
      throw new VoiceTokenUnavailableError(`Failed to mint voice token: ${message}`);
    }
  };
}
