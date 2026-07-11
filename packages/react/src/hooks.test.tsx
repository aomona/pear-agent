import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeVoiceProvider } from "@pear-agent/core";

import { PearClient } from "./client.js";
import { PearProvider } from "./provider.js";
import { __resetSessionChannelsForTests } from "./session-channel.js";
import { sampleMaterializedState, sampleSnapshot } from "./test-fixtures.js";
import { useContinuation } from "./use-continuation.js";
import { useExecutionSession } from "./use-execution-session.js";
import { useRuntimeSnapshot } from "./use-runtime-snapshot.js";
import { useVoiceSession } from "./use-voice-session.js";

function createWrapper(client: PearClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <PearProvider
        baseUrl="https://worker.example"
        getContext={() => ({ actorId: "traveler" })}
        client={client}
        realtime={false}
      >
        {children}
      </PearProvider>
    );
  };
}

afterEach(() => {
  __resetSessionChannelsForTests();
});

describe("react hooks", () => {
  it("useExecutionSession creates a session and completes a step", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sessions") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            sessionId: "s1",
            session: sampleSnapshot.session,
            plan: sampleSnapshot.plan,
            stepStates: sampleSnapshot.stepStates,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/events") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            kind: "applied",
            event: body,
            state: sampleMaterializedState({
              stepStatus: "completed",
              appliedIdempotencyKeys: [body.idempotencyKey],
            }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });

    const { result } = renderHook(() => useExecutionSession(), {
      wrapper: createWrapper(client),
    });

    await act(async () => {
      await result.current.create({
        domainId: "outing",
        actorIds: ["traveler"],
        goal: sampleSnapshot.plan.goal,
        normalizedInput: {},
      });
    });

    expect(result.current.sessionId).toBe("s1");
    expect(result.current.status).toBe("success");

    await act(async () => {
      const append = await result.current.completeStep({
        stepId: "pack",
        id: "s1-pack",
        idempotencyKey: "pack-done",
      });
      expect(append.kind).toBe("applied");
    });

    expect(result.current.error).toBeNull();
  });

  it("useExecutionSession(null) stays unbound after create (not controlled)", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          sessionId: "s1",
          session: sampleSnapshot.session,
          plan: sampleSnapshot.plan,
          stepStates: sampleSnapshot.stepStates,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });

    const { result } = renderHook(() => useExecutionSession(null), {
      wrapper: createWrapper(client),
    });

    await act(async () => {
      await result.current.create({
        domainId: "outing",
        actorIds: ["traveler"],
        goal: sampleSnapshot.plan.goal,
        normalizedInput: {},
      });
    });

    expect(result.current.sessionId).toBe("s1");
  });

  it("useRuntimeSnapshot loads snapshot over HTTP when realtime is off", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ snapshot: sampleSnapshot }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });

    const { result } = renderHook(() => useRuntimeSnapshot("s1"), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });

    expect(result.current.snapshot?.session.id).toBe("s1");
    expect(result.current.snapshot?.readyStepIds).toEqual(["pack"]);
    expect(result.current.continuation).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("useContinuation reports none while continuation is null", async () => {
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: vi.fn(async () => {
        return new Response(JSON.stringify({ snapshot: sampleSnapshot }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const { result } = renderHook(() => useContinuation("s1"), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });

    expect(result.current.continuation).toBeNull();
    expect(result.current.status).toBe("none");
  });

  it("rehydrates a persisted wake_pending Continuation without connecting voice", async () => {
    const continuation = {
      id: "cont-1",
      sessionId: "s1",
      status: "wake_pending",
      wakeCondition: { type: "manual" },
      suspendedReason: "User stepped away",
      resumeDirective: "Confirm the current state",
      checkpointPlanVersionId: "plan-1:1",
      checkpointLastEventId: null,
      providerResumeHandle: null,
      schedulerId: null,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:01:00.000Z",
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ snapshot: { ...sampleSnapshot, continuation } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });

    const { result } = renderHook(() => useContinuation("s1"), {
      wrapper: createWrapper(client),
    });
    await waitFor(() => expect(result.current.status).toBe("wake_pending"));

    expect(result.current.continuation?.id).toBe("cont-1");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("shares one HTTP channel between snapshot and continuation hooks", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ snapshot: sampleSnapshot }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });

    const { result } = renderHook(
      () => ({
        snap: useRuntimeSnapshot("s1"),
        cont: useContinuation("s1"),
      }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => {
      expect(result.current.snap.status).toBe("connected");
      expect(result.current.cont.connectionStatus).toBe("connected");
    });

    // Strict mode may double-invoke effects once each; still only one channel key.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("useRuntimeSnapshot surfaces HTTP errors", async () => {
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: vi.fn(async () => {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const { result } = renderHook(() => useRuntimeSnapshot("missing"), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });

    expect(result.current.error?.message).toContain("Session not found");
  });

  it("refetch reloads the HTTP snapshot", async () => {
    let packStatus: "ready" | "completed" = "ready";
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          snapshot: {
            ...sampleSnapshot,
            stepStates: { pack: { status: packStatus } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });

    const { result } = renderHook(() => useRuntimeSnapshot("s1"), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });
    expect(result.current.snapshot?.stepStates.pack?.status).toBe("ready");

    packStatus = "completed";
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.snapshot?.stepStates.pack?.status).toBe("completed");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("throws when hooks are used outside PearProvider", () => {
    expect(() => {
      renderHook(() => useExecutionSession());
    }).toThrow(/PearProvider/);
  });

  it("useVoiceSession connects via Fake provider and bridges tools without cancelling session", async () => {
    const provider = new FakeVoiceProvider();
    const sessionEvents: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/voice/lease") && method === "POST") {
        return new Response(
          JSON.stringify({
            lease: {
              id: "lease-1",
              sessionId: "s1",
              actorId: "traveler",
              status: "active",
              acquiredAt: "2026-07-11T00:00:00.000Z",
              expiresAt: "2026-07-11T00:30:00.000Z",
              providerResumeHandle: null,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/voice/token") && method === "POST") {
        return new Response(
          JSON.stringify({
            token: "ephemeral",
            model: "fake-model",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/voice/tools") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        sessionEvents.push(body.toolName);
        return new Response(
          JSON.stringify({
            callId: body.callId,
            toolName: body.toolName,
            ok: true,
            result: { kind: "applied", eventType: "step_completed", sessionStatus: "active" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/voice/lease") && method === "DELETE") {
        return new Response(
          JSON.stringify({
            lease: {
              id: "lease-1",
              sessionId: "s1",
              actorId: "traveler",
              status: "released",
              acquiredAt: "2026-07-11T00:00:00.000Z",
              expiresAt: "2026-07-11T00:30:00.000Z",
              providerResumeHandle: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/voice/resume-handle") && method === "PUT") {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            lease: {
              id: "lease-1",
              sessionId: "s1",
              actorId: "traveler",
              status: "active",
              acquiredAt: "2026-07-11T00:00:00.000Z",
              expiresAt: "2026-07-11T00:30:00.000Z",
              providerResumeHandle: body.handle,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/continuations") && method === "POST") {
        return new Response(
          JSON.stringify({
            continuation: {
              id: "cont-suspend",
              sessionId: "s1",
              status: "suspended",
              wakeCondition: { type: "manual" },
              suspendedReason: "Pause voice",
              resumeDirective: "Confirm state",
              checkpointPlanVersionId: "plan-1:1",
              checkpointLastEventId: null,
              providerResumeHandle: "handle-xyz",
              schedulerId: null,
              createdAt: "2026-07-11T00:00:00.000Z",
              updatedAt: "2026-07-11T00:00:00.000Z",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });

    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });

    const { result } = renderHook(() => useVoiceSession("s1", { provider }), {
      wrapper: createWrapper(client),
    });

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.status).toBe("connected");
    expect(result.current.lease?.id).toBe("lease-1");
    expect(result.current.error).toBeNull();

    const fakeConn = provider.connections[0]!;
    await act(async () => {
      fakeConn.emitToolCalls([{ id: "c1", name: "complete_step", args: { stepId: "pack" } }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(sessionEvents).toContain("complete_step");
    });
    expect(fakeConn.toolResponses.length).toBeGreaterThan(0);

    await act(async () => {
      fakeConn.emitResumeHandle("handle-xyz");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.lease?.providerResumeHandle).toBe("handle-xyz");
    });

    await act(async () => {
      await result.current.suspend({
        wakeCondition: { type: "manual" },
        suspendedReason: "Pause voice",
        resumeDirective: "Confirm state",
      });
    });

    expect(result.current.status).toBe("disconnected");
    expect(result.current.lease?.status).toBe("released");
    // Disconnect must not POST session_cancelled / session_paused.
    const cancelled = fetchMock.mock.calls.some((call) => {
      const url = String(call[0]);
      return url.includes("/events");
    });
    expect(cancelled).toBe(false);
  });

  it("falls back to a new Voice Session when a continuation resume handle is stale", async () => {
    const fallback = new FakeVoiceProvider();
    const attemptedHandles: Array<string | null | undefined> = [];
    const provider = {
      connect: async (options: Parameters<typeof fallback.connect>[0]) => {
        attemptedHandles.push(options.resumeHandle);
        if (options.resumeHandle) throw new Error("stale resume handle");
        return fallback.connect(options);
      },
    };
    const baseContinuation = {
      id: "cont-1",
      sessionId: "s1",
      wakeCondition: { type: "manual" as const },
      suspendedReason: "Interrupted",
      resumeDirective: "Confirm state",
      checkpointPlanVersionId: "plan-1:1",
      checkpointLastEventId: null,
      providerResumeHandle: "stale-handle",
      schedulerId: null,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:01:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/continuations/cont-1/resume")) {
        return new Response(
          JSON.stringify({
            continuation: {
              ...baseContinuation,
              status: "resuming",
              resumingActorId: "traveler",
              resumeAttemptId: "attempt-1",
              resumeClaimedAt: "2026-07-11T00:01:00.000Z",
            },
            snapshot: {
              ...sampleSnapshot,
              continuation: {
                ...baseContinuation,
                status: "resuming",
                resumingActorId: "traveler",
                resumeAttemptId: "attempt-1",
                resumeClaimedAt: "2026-07-11T00:01:00.000Z",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/voice/lease") && method === "POST") {
        return new Response(
          JSON.stringify({
            lease: {
              id: "lease-1",
              sessionId: "s1",
              actorId: "traveler",
              status: "active",
              acquiredAt: "2026-07-11T00:00:00.000Z",
              expiresAt: "2026-07-11T00:30:00.000Z",
              providerResumeHandle: "stale-handle",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/voice/token")) {
        return new Response(JSON.stringify({ token: "token", model: "fake" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/voice/resume-handle") && method === "PUT") {
        return new Response(
          JSON.stringify({
            lease: {
              id: "lease-1",
              sessionId: "s1",
              actorId: "traveler",
              status: "active",
              acquiredAt: "2026-07-11T00:00:00.000Z",
              expiresAt: "2026-07-11T00:30:00.000Z",
              providerResumeHandle: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/continuations/cont-1/complete")) {
        return new Response(
          JSON.stringify({ continuation: { ...baseContinuation, status: "completed" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });
    const { result } = renderHook(() => useVoiceSession("s1", { provider }), {
      wrapper: createWrapper(client),
    });

    await act(async () => result.current.connect({ continuationId: "cont-1" }));

    expect(result.current.status).toBe("connected");
    expect(attemptedHandles).toEqual(["stale-handle", null]);
    expect(fallback.connections).toHaveLength(1);
  });

  it("returns a claimed Continuation to wake_pending when Voice connect fails", async () => {
    let rolledBack = false;
    const continuation = {
      id: "cont-fail",
      sessionId: "s1",
      wakeCondition: { type: "manual" as const },
      suspendedReason: "Interrupted",
      resumeDirective: "Confirm state",
      checkpointPlanVersionId: "plan-1:1",
      checkpointLastEventId: null,
      providerResumeHandle: null,
      schedulerId: null,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:01:00.000Z",
    };
    const lease = {
      id: "lease-fail",
      sessionId: "s1",
      actorId: "traveler",
      acquiredAt: "2026-07-11T00:00:00.000Z",
      expiresAt: "2026-07-11T00:30:00.000Z",
      providerResumeHandle: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/voice/lease") && method === "POST") {
        return new Response(JSON.stringify({ lease: { ...lease, status: "active" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/continuations/cont-fail/resume")) {
        return new Response(
          JSON.stringify({
            continuation: {
              ...continuation,
              status: "resuming",
              resumingActorId: "traveler",
              resumeAttemptId: "attempt-fail",
              resumeClaimedAt: "2026-07-11T00:01:00.000Z",
            },
            snapshot: {
              ...sampleSnapshot,
              continuation: {
                ...continuation,
                status: "resuming",
                resumingActorId: "traveler",
                resumeAttemptId: "attempt-fail",
                resumeClaimedAt: "2026-07-11T00:01:00.000Z",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/voice/token")) {
        return new Response(JSON.stringify({ token: "token", model: "fake" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/continuations/cont-fail/resume-failed")) {
        rolledBack = true;
        return new Response(
          JSON.stringify({ continuation: { ...continuation, status: "wake_pending" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/voice/lease") && method === "DELETE") {
        return new Response(JSON.stringify({ lease: { ...lease, status: "released" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });
    const provider = { connect: async () => Promise.reject(new Error("provider unavailable")) };
    const { result } = renderHook(() => useVoiceSession("s1", { provider }), {
      wrapper: createWrapper(client),
    });

    await expect(
      act(async () => result.current.connect({ continuationId: "cont-fail" })),
    ).rejects.toThrow("provider unavailable");
    expect(rolledBack).toBe(true);
  });

  it("useVoiceSession session switch releases prior lease without painting it on the new session", async () => {
    const provider = new FakeVoiceProvider();
    const releasedSessions: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const sessionMatch = url.match(/\/sessions\/([^/]+)\/voice\//);
      const sessionId = sessionMatch?.[1] ?? "unknown";

      if (url.endsWith("/voice/lease") && method === "POST") {
        return new Response(
          JSON.stringify({
            lease: {
              id: `lease-${sessionId}`,
              sessionId,
              actorId: "traveler",
              status: "active",
              acquiredAt: "2026-07-11T00:00:00.000Z",
              expiresAt: "2026-07-11T00:30:00.000Z",
              providerResumeHandle: null,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/voice/token") && method === "POST") {
        return new Response(JSON.stringify({ token: "ephemeral", model: "fake-model" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/voice/lease") && method === "DELETE") {
        releasedSessions.push(sessionId);
        // Slow release so stale setState would race without epoch guards.
        await new Promise((r) => setTimeout(r, 20));
        return new Response(
          JSON.stringify({
            lease: {
              id: `lease-${sessionId}`,
              sessionId,
              actorId: "traveler",
              status: "released",
              acquiredAt: "2026-07-11T00:00:00.000Z",
              expiresAt: "2026-07-11T00:30:00.000Z",
              providerResumeHandle: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });

    const client = new PearClient({
      baseUrl: "https://worker.example",
      getContext: () => ({ actorId: "traveler" }),
      fetch: fetchMock as typeof fetch,
    });

    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useVoiceSession(sid, { provider }),
      {
        initialProps: { sid: "s1" },
        wrapper: createWrapper(client),
      },
    );

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.status).toBe("connected");
    expect(result.current.lease?.sessionId).toBe("s1");

    await act(async () => {
      rerender({ sid: "s2" });
    });

    // New session view starts idle; async release of s1 must not overwrite with released lease.
    expect(result.current.status).toBe("idle");
    expect(result.current.lease).toBeNull();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(releasedSessions).toContain("s1");
    expect(result.current.status).toBe("idle");
    expect(result.current.lease).toBeNull();
  });
});
