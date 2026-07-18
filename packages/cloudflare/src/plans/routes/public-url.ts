import { HTTPException } from "hono/http-exception";

const MAX_TEXT_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;

const SUPPORTED_FILE_TYPES = new Set([
  "application/json",
  "application/pdf",
  "text/html",
  "text/markdown",
  "text/plain",
]);

export function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

export function assertSupportedMediaType(mediaType: string): void {
  if (!SUPPORTED_FILE_TYPES.has(mediaType)) {
    throw new HTTPException(415, { message: `Unsupported source media type: ${mediaType}` });
  }
}

export function assertSize(size: number, mediaType: string): void {
  const maximum = maximumSize(mediaType);
  if (size > maximum) {
    throw new HTTPException(413, { message: `Source exceeds ${maximum} bytes` });
  }
}

export function maximumSize(mediaType: string): number {
  return mediaType === "application/pdf"
    ? MAX_PDF_BYTES
    : mediaType === "text/html"
      ? MAX_TEXT_SOURCE_BYTES
      : MAX_TEXT_FILE_BYTES;
}

export async function readBodyWithLimit(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  let bytes = new Uint8Array(Math.min(maximum, 64 * 1024));
  let total = 0;
  while (true) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel("PEAR source size limit exceeded");
      throw new HTTPException(413, { message: `Source exceeds ${maximum} bytes` });
    }
    if (total > bytes.byteLength) {
      const grown = new Uint8Array(Math.min(maximum, Math.max(total, bytes.byteLength * 2)));
      grown.set(bytes);
      bytes = grown;
    }
    bytes.set(value, total - value.byteLength);
  }
  return bytes.buffer.slice(0, total);
}

export function validatePublicUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HTTPException(400, { message: "Source URL must use http or https" });
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    isBlockedIpv4(host) ||
    isBlockedIpv6(host)
  ) {
    throw new HTTPException(400, { message: "Private network source URLs are not allowed" });
  }
  return url;
}

function isBlockedIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const normalized = host.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  const firstGroup = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (
    (firstGroup & 0xfe00) === 0xfc00 ||
    (firstGroup & 0xffc0) === 0xfe80 ||
    (firstGroup & 0xff00) === 0xff00
  )
    return true;
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  const mappedHex = normalized.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mappedHex) return false;
  const high = Number.parseInt(mappedHex[1]!, 16);
  const low = Number.parseInt(mappedHex[2]!, 16);
  return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
}

export async function fetchPublicSource(initial: URL, signal: AbortSignal): Promise<Response> {
  let url = initial;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new HTTPException(400, { message: "Source redirect has no location" });
    url = validatePublicUrl(new URL(location, url).toString());
  }
  throw new HTTPException(400, { message: "Source URL redirected too many times" });
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
