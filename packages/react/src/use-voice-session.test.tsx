import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeVoiceProvider } from "@pear-agent/core";

import { PearClient } from "./client.js";
import { PearProvider } from "./provider.js";
import { __resetSessionChannelsForTests } from "./session-channel.js";
import { sampleSnapshot } from "./test-fixtures.js";
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

describe("useVoiceSession", () => {
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

  it("releases the prior lease on a session switch without painting it on the new session", async () => {
    const provider = new FakeVoiceProvider();
    const releasedSessions: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const sessionId = url.match(/\/sessions\/([^/]+)\/voice\//)?.[1] ?? "unknown";
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
        await new Promise((resolve) => setTimeout(resolve, 20));
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

    await act(async () => result.current.connect());
    expect(result.current.lease?.sessionId).toBe("s1");
    await act(async () => rerender({ sid: "s2" }));
    expect(result.current.status).toBe("idle");
    expect(result.current.lease).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(releasedSessions).toContain("s1");
    expect(result.current.status).toBe("idle");
    expect(result.current.lease).toBeNull();
  });
});
