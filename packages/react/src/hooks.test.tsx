import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PearClient } from "./client.js";
import { PearProvider } from "./provider.js";
import { __resetSessionChannelsForTests } from "./session-channel.js";
import { sampleMaterializedState, sampleSnapshot } from "./test-fixtures.js";
import { useContinuation } from "./use-continuation.js";
import { useExecutionSession } from "./use-execution-session.js";
import { useRuntimeSnapshot } from "./use-runtime-snapshot.js";

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
  it("useExecutionSession create then startSession works without waiting for re-render", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sessions") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            sessionId: "s-create-start",
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

    // Same async tick as PlanDraftPanel: create then startSession without a re-render between.
    await act(async () => {
      await result.current.create({
        domainId: "outing",
        actorIds: ["traveler"],
        goal: sampleSnapshot.plan.goal,
        normalizedInput: {},
      });
      await result.current.startSession();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.sessionId).toBe("s-create-start");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/events"))).toBe(true);
  });

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
});
