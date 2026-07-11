import { describe, expect, it, vi } from "vitest";

import { PearClient } from "./client.js";
import { PearClientError } from "./errors.js";
import { sampleMaterializedState, sampleSnapshot } from "./test-fixtures.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PearClient", () => {
  it("sends x-pear-context and creates a session", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe("https://worker.example/sessions");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(JSON.parse(headers.get("x-pear-context")!)).toEqual({
        actorId: "traveler",
        roles: ["owner"],
        claims: { plan: "pro" },
      });
      return jsonResponse(
        {
          sessionId: "s1",
          session: sampleSnapshot.session,
          plan: sampleSnapshot.plan,
          stepStates: sampleSnapshot.stepStates,
        },
        201,
      );
    });

    const client = new PearClient({
      baseUrl: "https://worker.example/",
      getContext: () => ({
        actorId: "traveler",
        roles: ["owner"],
        claims: { plan: "pro" },
      }),
      fetch: fetchMock as typeof fetch,
    });

    const result = await client.createSession({
      domainId: "outing",
      actorIds: ["traveler"],
      goal: sampleSnapshot.plan.goal,
      normalizedInput: { destination: "station" },
    });

    expect(result.sessionId).toBe("s1");
    expect(result.session.createdAt).toBeInstanceOf(Date);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("parses snapshot dates via Core schema", async () => {
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: async () => ({ actorId: "traveler" }),
      fetch: vi.fn(async () => jsonResponse({ snapshot: sampleSnapshot })) as typeof fetch,
    });

    const parsed = await client.getSnapshot("s1");
    expect(parsed.session.id).toBe("s1");
    expect(parsed.session.createdAt).toBeInstanceOf(Date);
    expect(parsed.generatedAt).toBeInstanceOf(Date);
  });

  it("builds a step_completed event with context actorId", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.type).toBe("step_completed");
      expect(body.payload).toEqual({ stepId: "pack" });
      expect(body.actorId).toBe("traveler");
      expect(body.sessionId).toBe("s1");
      expect(body.origin).toBe("user");
      return jsonResponse({
        kind: "applied",
        event: body,
        state: sampleMaterializedState({
          stepStatus: "completed",
          appliedIdempotencyKeys: [body.idempotencyKey],
        }),
      });
    });

    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });

    const result = await client.completeStep("s1", {
      stepId: "pack",
      idempotencyKey: "pack-done",
      id: "s1-pack-done",
      occurredAt: "2026-07-11T00:02:00.000Z",
    });

    expect(result.kind).toBe("applied");
    expect(result.state.stepStates.pack?.status).toBe("completed");
  });

  it("throws PearClientError on non-OK responses", async () => {
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: vi.fn(async () => jsonResponse({ error: "Session not found" }, 404)) as typeof fetch,
    });

    await expect(client.getSession("missing")).rejects.toMatchObject({
      name: "PearClientError",
      status: 404,
      message: "Session not found",
    } satisfies Partial<PearClientError>);
  });

  it("setGetContext updates the resolver without a new client instance", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(JSON.parse(headers.get("x-pear-context")!).actorId).toBe("new");
      return jsonResponse(
        {
          sessionId: "s1",
          session: sampleSnapshot.session,
          plan: sampleSnapshot.plan,
          stepStates: sampleSnapshot.stepStates,
        },
        201,
      );
    });
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "old" }),
      fetch: fetchMock as typeof fetch,
    });
    client.setGetContext(() => ({ actorId: "new", roles: ["r"] }));
    await client.createSession({
      domainId: "outing",
      actorIds: ["traveler"],
      goal: sampleSnapshot.plan.goal,
      normalizedInput: {},
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
