/** Browser demo UI (Vite) is cross-origin from the Worker; handle preflight + headers. */

const DEFAULT_ALLOW_HEADERS = [
  "Content-Type",
  "x-pear-context",
  "X-Pear-Context",
  "x-pear-deny",
].join(", ");

export type CorsOptions = {
  /** Comma-separated or `*` (default). Reflect request Origin when not `*`. */
  allowOrigin?: string;
};

function corsHeaders(request: Request, options: CorsOptions = {}): Headers {
  const configured = options.allowOrigin ?? "*";
  const requestOrigin = request.headers.get("Origin");
  const allowOrigin = configured === "*" ? (requestOrigin ?? "*") : configured;

  const headers = new Headers({
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      request.headers.get("Access-Control-Request-Headers") ?? DEFAULT_ALLOW_HEADERS,
    "Access-Control-Max-Age": "86400",
  });
  if (allowOrigin !== "*") {
    headers.set("Vary", "Origin");
  }
  return headers;
}

/** Handle CORS preflight. Returns a 204 response, or null to continue. */
export function handleCorsPreflight(request: Request, options?: CorsOptions): Response | null {
  if (request.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(request, options) });
}

/** Copy CORS headers onto an existing response (does not consume body). */
export function withCors(request: Request, response: Response, options?: CorsOptions): Response {
  const headers = new Headers(response.headers);
  const extra = corsHeaders(request, options);
  extra.forEach((value, key) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
