import type { RuntimeSnapshot, VoiceLease } from "@pear-agent/core";

import { VoiceTokenUnavailableError } from "../errors.js";
import {
  listVoiceToolDeclarations,
  summarizeSnapshotForVoice,
  type VoiceToolRegistry,
} from "./tools.js";

export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

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
  registry?: VoiceToolRegistry;
};

/**
 * Port for Gemini Live ephemeral token minting.
 * Production uses {@link createGoogleGenaiTokenMinter}; tests inject a stub.
 */
export type VoiceTokenMinter = (input: MintVoiceTokenInput) => Promise<VoiceEphemeralTokenResult>;

/** Server-only Live config locked into the ephemeral token (not returned to clients). */
export function buildVoiceLiveConfig(input: {
  snapshot: RuntimeSnapshot;
  lease: VoiceLease;
  registry?: VoiceToolRegistry;
}): Record<string, unknown> {
  const summary = summarizeSnapshotForVoice(input.snapshot);
  const tools = listVoiceToolDeclarations(input.registry);
  const systemInstruction = [
    "You are a PEAR Runtime voice assistant helping the user execute a real-world plan.",
    "Prefer short, concrete guidance.",
    "Never claim a step, timer, or session state changed until the corresponding tool call succeeds.",
    "Use get_runtime_snapshot when state may have changed or when you are unsure.",
    "Voice disconnect must never be treated as session cancellation; only call pause_session when the user asks to pause work.",
    "Current runtime summary JSON:",
    JSON.stringify(summary),
  ].join("\n");

  const sessionResumption: Record<string, unknown> = {};
  if (input.lease.providerResumeHandle) {
    sessionResumption.handle = input.lease.providerResumeHandle;
  }

  return {
    responseModalities: ["AUDIO"],
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
 * Live config is locked into the token server-side and not returned to clients.
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
