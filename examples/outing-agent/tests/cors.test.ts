import { describe, expect, it } from "vitest";

import { handleCorsPreflight, withCors } from "../worker/src/cors.js";

describe("outing-agent CORS", () => {
  it("answers OPTIONS preflight with 204 and allow headers", () => {
    const request = new Request("http://127.0.0.1:8787/sessions", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-pear-context",
      },
    });
    const response = handleCorsPreflight(request);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(204);
    expect(response!.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(response!.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response!.headers.get("Access-Control-Allow-Headers")).toMatch(/x-pear-context/i);
  });

  it("attaches CORS headers to normal responses", () => {
    const request = new Request("http://127.0.0.1:8787/health", {
      headers: { Origin: "http://localhost:5173" },
    });
    const response = withCors(request, Response.json({ ok: true }));
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(response.headers.get("content-type")).toMatch(/json/);
  });
});
