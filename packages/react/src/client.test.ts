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

  it("preserves plain-text error response bodies", async () => {
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: vi.fn(
        async () =>
          new Response("upstream gateway timeout", {
            status: 504,
            headers: { "content-type": "text/plain" },
          }),
      ) as typeof fetch,
    });

    await expect(client.getSession("s1")).rejects.toMatchObject({
      name: "PearClientError",
      status: 504,
      message: "upstream gateway timeout",
    } satisfies Partial<PearClientError>);
  });

  it("uses a response message when the error field is non-string", async () => {
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: vi.fn(async () =>
        jsonResponse({ error: true, message: "Explicit confirmation is required" }, 409),
      ) as typeof fetch,
    });
    await expect(client.getSession("s1")).rejects.toMatchObject({
      status: 409,
      message: "Explicit confirmation is required",
    });
  });

  it("parses inspector dates and nested records", async () => {
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: vi.fn(async () =>
        jsonResponse({
          inspector: {
            sources: [],
            jobs: [
              {
                id: "job-1",
                planArtifactId: "plan-1",
                workflowInstanceId: null,
                phase: "review",
                status: "completed",
                attempt: 1,
                modelCalls: 2,
                totalTokens: 10,
                error: null,
                createdAt: "2026-07-18T00:00:00.000Z",
                updatedAt: "2026-07-18T00:01:00.000Z",
              },
            ],
            interpretations: [],
            clarifications: [],
            generations: [],
          },
        }),
      ) as typeof fetch,
    });
    const inspector = await client.getPlanInspector("plan-1");
    expect(inspector.jobs[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("requests a partial replan and parses the affected diff", async () => {
    const patch = {
      id: "patch-1",
      basePlanId: sampleSnapshot.plan.id,
      basePlanVersion: sampleSnapshot.plan.version,
      baseLastEventId: null,
      causeEventIds: ["delay-1"],
      affectedStepIds: ["pack"],
      operations: [
        {
          type: "update_step" as const,
          stepId: "pack",
          step: { ...sampleSnapshot.plan.steps[0], estimatedDurationSeconds: 90 },
        },
      ],
      summary: "Allow more packing time",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://worker.example/sessions/s1/replans");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ mode: "confirm" });
      return jsonResponse({
        kind: "pending_confirmation",
        assessment: {
          needsReplan: true,
          causeEventIds: ["delay-1"],
          directlyAffectedStepIds: ["pack"],
          reason: "Departure moved",
        },
        affectedSubgraph: { rootStepIds: ["pack"], stepIds: ["pack"] },
        planChange: {
          patch,
          mode: "confirm",
          status: "pending_confirmation",
          targetPlanVersion: null,
          failureReason: null,
          activeStepIdsAtProposal: [],
          validationDomainVersion: 1,
          validationNormalizedInputRevision: 1,
          createdAt: "2026-07-11T00:02:00.000Z",
          updatedAt: "2026-07-11T00:02:00.000Z",
        },
        state: sampleMaterializedState(),
      });
    });
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });

    const result = await client.requestReplan("s1", "confirm");

    expect(result.kind).toBe("pending_confirmation");
    if (result.kind === "not_needed") throw new Error("Expected a plan change");
    expect(result.affectedSubgraph.stepIds).toEqual(["pack"]);
    expect(result.planChange.createdAt).toBeInstanceOf(Date);
    expect(result.planChange.patch.summary).toBe("Allow more packing time");
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

  it("starts keepalive requests synchronously with the lease context", async () => {
    const lease = {
      id: "lease-1",
      sessionId: "s1",
      actorId: "traveler",
      status: "active",
      acquiredAt: "2026-07-11T00:00:00.000Z",
      expiresAt: "2026-07-11T00:30:00.000Z",
      providerResumeHandle: null,
    };
    const getContext = vi.fn(async () => ({ actorId: "traveler" }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      const sessionId = String(input).includes("/sessions/s2/") ? "s2" : "s1";
      return jsonResponse({
        lease: {
          ...lease,
          sessionId,
          actorId: sessionId === "s2" ? "other-actor" : "traveler",
          providerResumeHandle: body?.handle ?? null,
        },
      });
    });
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext,
      fetch: fetchMock as typeof fetch,
    });
    await client.acquireVoiceLease("s1", { leaseId: "lease-1" });
    client.setGetContext(async () => ({ actorId: "other-actor" }));
    await client.acquireVoiceLease("s2", { leaseId: "lease-1" });

    const request = client.setVoiceResumeHandle("s1", "latest", {
      keepalive: true,
      leaseId: "lease-1",
    });

    expect(getContext).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keepaliveInit = fetchMock.mock.calls[2]?.[1];
    expect(keepaliveInit?.keepalive).toBe(true);
    expect(JSON.parse(String(keepaliveInit?.body))).toEqual({
      handle: "latest",
      leaseId: "lease-1",
    });
    expect(JSON.parse(new Headers(keepaliveInit?.headers).get("x-pear-context")!)).toEqual({
      actorId: "traveler",
      roles: [],
      claims: {},
    });
    await request;

    await client.releaseVoiceLease("s1");
    const releaseInit = fetchMock.mock.calls[3]?.[1];
    expect(releaseInit?.method).toBe("DELETE");
    expect(JSON.parse(new Headers(releaseInit?.headers).get("x-pear-context")!)).toEqual({
      actorId: "traveler",
      roles: [],
      claims: {},
    });
  });
});
