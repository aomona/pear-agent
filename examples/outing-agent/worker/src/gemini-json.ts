/**
 * Thin Gemini structured-JSON helper for outing plan library (normalize / improve).
 * Optimized for low latency: flash-lite + thinking off + small max tokens.
 */

/**
 * Fast structured extraction — lite model, thinking disabled.
 * Override per-call via `model` if needed.
 */
export const OUTING_GEMINI_TEXT_MODEL = "gemini-3.1-flash-lite";

export class GeminiServiceError extends Error {
  readonly status: 400 | 502 | 503;

  constructor(message: string, status: 400 | 502 | 503 = 502) {
    super(message);
    this.name = "GeminiServiceError";
    this.status = status;
  }
}

export type GenerateJsonInput = {
  apiKey: string | undefined;
  model?: string;
  system: string;
  user: string;
  /** JSON Schema object for structured output. */
  schema: Record<string, unknown>;
  /** Cap output size (default small for field extraction). */
  maxOutputTokens?: number;
};

type GenConfig = {
  systemInstruction: string;
  responseMimeType: string;
  responseJsonSchema: Record<string, unknown>;
  temperature: number;
  maxOutputTokens: number;
  thinkingConfig?: {
    thinkingBudget: number;
    includeThoughts: boolean;
  };
};

async function callOnce(
  apiKey: string,
  model: string,
  user: string,
  config: GenConfig,
): Promise<unknown> {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model,
    contents: user,
    config,
  });

  const text = response.text?.trim();
  if (!text) {
    throw new GeminiServiceError("Gemini returned an empty structured response", 502);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GeminiServiceError("Gemini returned non-JSON structured output", 502);
  }
}

/**
 * Call Gemini and parse JSON text. Throws {@link GeminiServiceError} on config/API failure.
 */
export async function generateGeminiJson(input: GenerateJsonInput): Promise<unknown> {
  if (!input.apiKey) {
    throw new GeminiServiceError(
      "GEMINI_API_KEY is not configured (required for free-text resolve / plan improve)",
      503,
    );
  }

  const model = input.model ?? OUTING_GEMINI_TEXT_MODEL;
  const maxOutputTokens = input.maxOutputTokens ?? 512;
  const base = {
    systemInstruction: input.system,
    responseMimeType: "application/json",
    responseJsonSchema: input.schema,
    temperature: 0,
    maxOutputTokens,
  } as const;

  try {
    // thinkingBudget: 0 = disable reasoning (huge latency win on Flash family).
    return await callOnce(input.apiKey, model, input.user, {
      ...base,
      thinkingConfig: {
        thinkingBudget: 0,
        includeThoughts: false,
      },
    });
  } catch (error) {
    if (error instanceof GeminiServiceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // Some model variants reject thinkingConfig — retry bare for compatibility.
    if (/thinking|ThinkingConfig|invalid|unknown field/i.test(message)) {
      try {
        return await callOnce(input.apiKey, model, input.user, { ...base });
      } catch (retryError) {
        if (retryError instanceof GeminiServiceError) throw retryError;
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        throw new GeminiServiceError(`Gemini request failed: ${retryMsg}`, 502);
      }
    }
    throw new GeminiServiceError(`Gemini request failed: ${message}`, 502);
  }
}
