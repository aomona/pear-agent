/**
 * Thin Gemini structured-JSON helper for outing plan library (normalize / improve).
 * Uses @google/genai generateContent + responseJsonSchema (not Live API).
 */

export const OUTING_GEMINI_TEXT_MODEL = "gemini-3.5-flash";

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
};

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

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const client = new GoogleGenAI({ apiKey: input.apiKey });
    const response = await client.models.generateContent({
      model,
      contents: input.user,
      config: {
        systemInstruction: input.system,
        responseMimeType: "application/json",
        responseJsonSchema: input.schema,
        temperature: 0.2,
      },
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
  } catch (error) {
    if (error instanceof GeminiServiceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new GeminiServiceError(`Gemini request failed: ${message}`, 502);
  }
}
