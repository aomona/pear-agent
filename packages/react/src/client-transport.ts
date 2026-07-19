import { PearClientError } from "./errors.js";

/** Join base URL and path without double slashes. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Generate a prefixed id (UUID when available). */
export function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Parse a non-OK Response into PearClientError. */
export async function responseToPearClientError(response: Response): Promise<PearClientError> {
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text || undefined;
  }
  const message =
    typeof body === "object" && body !== null
      ? typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : `PEAR request failed (${response.status})`
      : typeof body === "string" && body.trim()
        ? body
        : `PEAR request failed (${response.status})`;
  return new PearClientError(message, response.status, body);
}

/** Delay that rejects when the signal aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
