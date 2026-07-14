import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { contextHeaders, createSession, pearEnv } from "./test/integration-helpers.js";

describe("cloudflare runtime integration", () => {
  it("persists session and snapshot across reads (D1 durable)", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const created = await createSession(sessionId);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      sessionId: string;
      plan: { id: string };
    };
    expect(createdBody.sessionId).toBe(sessionId);
    expect(createdBody.plan.id).toBe("outing-plan");

    const started = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...contextHeaders(),
        },
        body: JSON.stringify({
          id: `${sessionId}-evt-start`,
          sessionId,
          idempotencyKey: "session-start",
          actorId: "traveler",
          origin: "user",
          type: "session_started",
          payload: {},
          occurredAt: "2026-07-11T00:00:00.000Z",
        }),
      }),
    );
    expect(started.status).toBe(200);
    const startedBody = (await started.json()) as {
      kind: string;
      state: { session: { status: string } };
    };
    expect(startedBody.kind).toBe("applied");
    expect(startedBody.state.session.status).toBe("active");

    const snapshotRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/snapshot`, {
        headers: contextHeaders(),
      }),
    );
    expect(snapshotRes.status).toBe(200);
    const snapshotBody = (await snapshotRes.json()) as {
      snapshot: { session: { status: string }; recentEvents: unknown[] };
    };
    expect(snapshotBody.snapshot.session.status).toBe("active");
    expect(snapshotBody.snapshot.recentEvents.length).toBe(1);

    // Second read exercises durable D1 + agent rehydrate path.
    const again = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/snapshot`, {
        headers: contextHeaders(),
      }),
    );
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as {
      snapshot: { session: { id: string; status: string } };
    };
    expect(againBody.snapshot.session.id).toBe(sessionId);
    expect(againBody.snapshot.session.status).toBe("active");
  });

  it("rejects unauthorized operations without mutating state", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);

    const denied = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...contextHeaders({ "x-pear-deny": "1" }),
        },
        body: JSON.stringify({
          id: `${sessionId}-evt-denied`,
          sessionId,
          idempotencyKey: "denied",
          actorId: "traveler",
          origin: "user",
          type: "session_started",
          payload: {},
          occurredAt: "2026-07-11T00:00:00.000Z",
        }),
      }),
    );
    expect(denied.status).toBe(403);

    const stateRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}`, {
        headers: contextHeaders(),
      }),
    );
    const stateBody = (await stateRes.json()) as { state: { session: { status: string } } };
    expect(stateBody.state.session.status).toBe("not_started");
  });

  it("stores raw input in R2 and normalized input in D1", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);

    const form = new FormData();
    form.set(
      "file",
      new File([JSON.stringify({ note: "raw" })], "input.json", { type: "application/json" }),
    );

    const rawRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/raw-inputs`, {
        method: "POST",
        headers: contextHeaders(),
        body: form,
      }),
    );
    expect(rawRes.status).toBe(201);
    const rawBody = (await rawRes.json()) as {
      rawInput: { id: string; objectKey: string; checksumSha256: string; byteSize: number };
    };
    expect(rawBody.rawInput.objectKey).toContain(sessionId);
    expect(rawBody.rawInput.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rawBody.rawInput.byteSize).toBeGreaterThan(0);

    const object = await pearEnv.RAW_INPUTS.get(rawBody.rawInput.objectKey);
    expect(object).not.toBeNull();
    expect(await object!.text()).toContain("raw");

    const d1Row = await pearEnv.DB.prepare(
      `SELECT object_key, checksum_sha256 FROM raw_inputs WHERE id = ?`,
    )
      .bind(rawBody.rawInput.id)
      .first<{ object_key: string; checksum_sha256: string }>();
    expect(d1Row?.object_key).toBe(rawBody.rawInput.objectKey);
    expect(d1Row?.checksum_sha256).toBe(rawBody.rawInput.checksumSha256);

    const normalizedRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/normalized-input`, {
        headers: contextHeaders(),
      }),
    );
    expect(normalizedRes.status).toBe(200);
    const normalizedBody = (await normalizedRes.json()) as {
      normalizedInput: { departureAt: string };
    };
    expect(normalizedBody.normalizedInput.departureAt).toBe("2026-07-11T03:00:00Z");
  });

  it("publishes invalidation pulse on Agent sync state after mutations", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);

    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    const afterCreate = await agent.getSyncState();
    expect(afterCreate.revision).toBeGreaterThan(0);
    expect(afterCreate.continuation).toBeNull();
    expect(afterCreate.lastEventId).toBeNull();

    const started = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...contextHeaders(),
        },
        body: JSON.stringify({
          id: `${sessionId}-evt-start-sync`,
          sessionId,
          idempotencyKey: "session-start-sync",
          actorId: "traveler",
          origin: "user",
          type: "session_started",
          payload: {},
          occurredAt: "2026-07-11T00:00:00.000Z",
        }),
      }),
    );
    expect(started.status).toBe(200);

    const afterEvent = await agent.getSyncState();
    expect(afterEvent.revision).toBeGreaterThan(afterCreate.revision);
    expect(afterEvent.lastEventId).toBe(`${sessionId}-evt-start-sync`);
  });

  it("serializes concurrent appends for the same session via the Agent", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);

    const start = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...contextHeaders(),
        },
        body: JSON.stringify({
          id: `${sessionId}-evt-session-start`,
          sessionId,
          idempotencyKey: "session-start",
          actorId: "traveler",
          origin: "user",
          type: "session_started",
          payload: {},
          occurredAt: "2026-07-11T00:00:00.000Z",
        }),
      }),
    );
    expect(start.status).toBe(200);

    const results = await Promise.all(
      ["pack", "charge"].map(async (stepId, index) => {
        const response = await exports.default.fetch(
          new Request(`http://example.com/sessions/${sessionId}/events`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...contextHeaders(),
            },
            body: JSON.stringify({
              id: `${sessionId}-evt-${stepId}-start`,
              sessionId,
              idempotencyKey: `${stepId}-start`,
              actorId: "traveler",
              origin: "user",
              type: "step_started",
              payload: { stepId },
              occurredAt: new Date(Date.UTC(2026, 6, 11, 0, 0, index + 1)).toISOString(),
            }),
          }),
        );
        return response.json() as Promise<{ kind: string }>;
      }),
    );

    expect(results.every((result) => result.kind === "applied")).toBe(true);

    const stateRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}`, {
        headers: contextHeaders(),
      }),
    );
    const stateBody = (await stateRes.json()) as {
      state: {
        stepStates: Record<string, { status: string }>;
        appliedEventIds: string[];
      };
    };
    expect(stateBody.state.stepStates.pack?.status).toBe("active");
    expect(stateBody.state.stepStates.charge?.status).toBe("active");
    expect(stateBody.state.appliedEventIds).toHaveLength(3);
  });

  it("is idempotent for duplicate event keys", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);

    const body = {
      id: `${sessionId}-evt-start`,
      sessionId,
      idempotencyKey: "session-start",
      actorId: "traveler",
      origin: "user",
      type: "session_started",
      payload: {},
      occurredAt: "2026-07-11T00:00:00.000Z",
    };

    const first = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify(body),
      }),
    );
    const second = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify(body),
      }),
    );

    expect(((await first.json()) as { kind: string }).kind).toBe("applied");
    expect(((await second.json()) as { kind: string }).kind).toBe("duplicate");
  });

  it("enforces exclusive voice lease and keeps session active after release", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);

    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-evt-start-voice`,
          sessionId,
          idempotencyKey: "session-start-voice",
          actorId: "traveler",
          origin: "user",
          type: "session_started",
          payload: {},
          occurredAt: "2026-07-11T00:00:00.000Z",
        }),
      }),
    );

    const leaseRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/lease`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({ leaseId: "lease-old" }),
      }),
    );
    expect(leaseRes.status).toBe(201);
    const leaseBody = (await leaseRes.json()) as {
      lease: { id: string; actorId: string; status: string };
    };
    expect(leaseBody.lease.status).toBe("active");
    expect(leaseBody.lease.actorId).toBe("traveler");

    const conflict = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/lease`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pear-context": JSON.stringify({
            actorId: "other-user",
            roles: [],
            claims: {},
          }),
        },
        body: JSON.stringify({}),
      }),
    );
    expect(conflict.status).toBe(409);

    const handleRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/resume-handle`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({ handle: "gemini-handle-1", leaseId: "lease-old" }),
      }),
    );
    expect(handleRes.status).toBe(200);
    const handleBody = (await handleRes.json()) as {
      lease: { providerResumeHandle: string | null };
    };
    expect(handleBody.lease.providerResumeHandle).toBe("gemini-handle-1");

    const newerHandleRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/resume-handle`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          handle: "gemini-handle-2",
          leaseId: "lease-old",
          expectedHandles: [null, "gemini-handle-1"],
        }),
      }),
    );
    expect(newerHandleRes.status).toBe(200);

    const staleHandleRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/resume-handle`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          handle: "stale-handle",
          leaseId: "lease-old",
          expectedHandles: [null],
        }),
      }),
    );
    expect(staleHandleRes.status).toBe(200);
    const staleHandleBody = (await staleHandleRes.json()) as {
      lease: { providerResumeHandle: string | null };
    };
    expect(staleHandleBody.lease.providerResumeHandle).toBe("gemini-handle-2");

    const tokenRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/token`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({}),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      token: string;
      model: string;
      config?: unknown;
    };
    expect(tokenBody.token).toContain("test-token");
    expect(tokenBody.model).toBe("test-model");
    // Live config stays locked server-side; must not be returned to clients.
    expect(tokenBody.config).toBeUndefined();

    const startStep = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/tools`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          toolName: "start_step",
          args: { stepId: "pack" },
          callId: "call-0",
        }),
      }),
    );
    expect(startStep.status).toBe(200);
    expect(((await startStep.json()) as { ok: boolean }).ok).toBe(true);

    const toolRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/tools`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          toolName: "complete_step",
          args: { stepId: "pack" },
          callId: "call-1",
        }),
      }),
    );
    expect(toolRes.status).toBe(200);
    const toolBody = (await toolRes.json()) as { ok: boolean; result: { eventType: string } };
    expect(toolBody.ok).toBe(true);
    expect(toolBody.result.eventType).toBe("step_completed");

    const releaseRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/lease`, {
        method: "DELETE",
        headers: contextHeaders(),
      }),
    );
    expect(releaseRes.status).toBe(200);

    const nextLeaseRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/lease`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({ leaseId: "lease-new" }),
      }),
    );
    expect(nextLeaseRes.status).toBe(201);

    const oldLeaseHandleRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/resume-handle`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          handle: "old-lease-handle",
          leaseId: "lease-old",
          expectedHandles: ["gemini-handle-2"],
        }),
      }),
    );
    expect(oldLeaseHandleRes.status).toBe(200);
    const oldLeaseHandleBody = (await oldLeaseHandleRes.json()) as {
      lease: { id: string; providerResumeHandle: string | null };
    };
    expect(oldLeaseHandleBody.lease.id).toBe("lease-new");
    expect(oldLeaseHandleBody.lease.providerResumeHandle).toBe("gemini-handle-2");

    const nextReleaseRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/lease`, {
        method: "DELETE",
        headers: contextHeaders(),
      }),
    );
    expect(nextReleaseRes.status).toBe(200);

    const stateRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}`, {
        headers: contextHeaders(),
      }),
    );
    const stateBody = (await stateRes.json()) as {
      state: { session: { status: string }; stepStates: Record<string, { status: string }> };
    };
    // Voice release must not stop the Execution Session.
    expect(stateBody.state.session.status).toBe("active");
    expect(stateBody.state.stepStates.pack?.status).toBe("completed");
  });

  it("rejects unauthorized voice tools without mutating state", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);

    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/lease`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({}),
      }),
    );

    const denied = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/tools`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...contextHeaders({ "x-pear-deny": "1" }),
        },
        body: JSON.stringify({
          toolName: "start_session",
          args: {},
        }),
      }),
    );
    expect(denied.status).toBe(403);

    const stateRes = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}`, {
        headers: contextHeaders(),
      }),
    );
    const stateBody = (await stateRes.json()) as { state: { session: { status: string } } };
    expect(stateBody.state.session.status).toBe("not_started");
  });

  it("persists Continuation, wakes on event, and allows only one resume claim", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);

    const suspended = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-cont`,
          wakeCondition: { type: "event", eventType: "session_started" },
          suspendedReason: "Wait until execution starts",
          resumeDirective: "Confirm the current plan before continuing",
        }),
      }),
    );
    expect(suspended.status).toBe(201);
    const suspendedBody = (await suspended.json()) as {
      continuation: { id: string; status: string };
    };
    expect(suspendedBody.continuation.status).toBe("suspended");

    // A fresh HTTP read proves D1 hydration rather than hook-local state.
    const persisted = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuation`, {
        headers: contextHeaders(),
      }),
    );
    expect(persisted.status).toBe(200);
    expect(((await persisted.json()) as { continuation: { id: string } }).continuation.id).toBe(
      suspendedBody.continuation.id,
    );

    const started = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-start-for-wake`,
          sessionId,
          idempotencyKey: "start-for-wake",
          actorId: "traveler",
          origin: "user",
          type: "session_started",
          payload: {},
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    expect(started.status).toBe(200);

    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    expect((await agent.getSyncState()).continuation?.status).toBe("wake_pending");

    const resumeUrl = `http://example.com/sessions/${sessionId}/continuations/${suspendedBody.continuation.id}/resume`;
    const [first, second] = await Promise.all(
      [0, 1].map(() =>
        exports.default.fetch(
          new Request(resumeUrl, {
            method: "POST",
            headers: { "content-type": "application/json", ...contextHeaders() },
            body: "{}",
          }),
        ),
      ),
    );
    expect([first.status, second.status].sort()).toEqual([200, 409]);

    const winner = first.status === 200 ? first : second;
    const claimed = (await winner.json()) as {
      continuation: { status: string; resumeAttemptId: string };
      snapshot: {
        session: { id: string };
        recentEvents: Array<{ id: string }>;
        continuation: { status: string };
      };
    };
    expect(claimed.continuation.status).toBe("resuming");
    expect(claimed.snapshot.session.id).toBe(sessionId);
    expect(
      claimed.snapshot.recentEvents.some((event) => event.id === `${sessionId}-start-for-wake`),
    ).toBe(true);
    expect(claimed.snapshot.continuation.status).toBe("resuming");

    const failed = await exports.default.fetch(
      new Request(
        `http://example.com/sessions/${sessionId}/continuations/${suspendedBody.continuation.id}/resume-failed`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify({ attemptId: claimed.continuation.resumeAttemptId }),
        },
      ),
    );
    expect(failed.status).toBe(200);
    expect(
      ((await failed.json()) as { continuation: { status: string } }).continuation.status,
    ).toBe("wake_pending");
    const retried = await exports.default.fetch(
      new Request(resumeUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(retried.status).toBe(200);
    const retriedBody = (await retried.json()) as {
      continuation: { resumeAttemptId: string };
    };
    expect(retriedBody.continuation.resumeAttemptId).not.toBe(claimed.continuation.resumeAttemptId);

    const wrongActor = await exports.default.fetch(
      new Request(
        `http://example.com/sessions/${sessionId}/continuations/${suspendedBody.continuation.id}/resume-failed`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pear-context": JSON.stringify({ actorId: "other-user", roles: [], claims: {} }),
          },
          body: JSON.stringify({ attemptId: retriedBody.continuation.resumeAttemptId }),
        },
      ),
    );
    expect(wrongActor.status).toBe(409);

    await agent.recoverStaleContinuationResume({
      continuationId: suspendedBody.continuation.id,
      attemptId: retriedBody.continuation.resumeAttemptId,
    });
    expect((await agent.getSyncState()).continuation?.status).toBe("wake_pending");

    const audit = await pearEnv.DB.prepare(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT id) AS distinct_count
       FROM runtime_events
       WHERE session_id = ? AND event_json LIKE '%continuation_resum%'`,
    )
      .bind(sessionId)
      .first<{ count: number; distinct_count: number }>();
    expect(audit?.count).toBe(4);
    expect(audit?.distinct_count).toBe(4);
  });

  it("does not wake an event Continuation from a duplicate event retry", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const event = {
      id: `${sessionId}-old-start`,
      sessionId,
      idempotencyKey: "old-start",
      actorId: "traveler",
      origin: "user",
      type: "session_started",
      payload: {},
      occurredAt: new Date().toISOString(),
    };
    const append = () =>
      exports.default.fetch(
        new Request(`http://example.com/sessions/${sessionId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify(event),
        }),
      );
    expect((await append()).status).toBe(200);
    expect(
      (
        await exports.default.fetch(
          new Request(`http://example.com/sessions/${sessionId}/continuations`, {
            method: "POST",
            headers: { "content-type": "application/json", ...contextHeaders() },
            body: JSON.stringify({
              wakeCondition: { type: "event", eventType: "session_started" },
              suspendedReason: "Wait for a new start event",
              resumeDirective: "Check current state",
            }),
          }),
        )
      ).status,
    ).toBe(201);

    const duplicate = await append();
    expect(((await duplicate.json()) as { kind: string }).kind).toBe("duplicate");
    const continuation = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuation`, {
        headers: contextHeaders(),
      }),
    );
    expect(
      ((await continuation.json()) as { continuation: { status: string } }).continuation.status,
    ).toBe("suspended");
  });

  it("registers a time Wake and publishes wake_pending when the scheduler fires", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const continuationId = `${sessionId}-time-cont`;

    const response = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: continuationId,
          wakeCondition: {
            type: "time",
            wakeAt: new Date(Date.now() + 60_000).toISOString(),
          },
          suspendedReason: "Wait one minute",
          resumeDirective: "Recheck the latest snapshot",
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      continuation: { status: string; schedulerId: string | null };
    };
    expect(body.continuation.status).toBe("suspended");
    expect(body.continuation.schedulerId).not.toBeNull();

    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    await agent.wakeContinuation({ continuationId });
    expect((await agent.getSyncState()).continuation?.status).toBe("wake_pending");
  });
});
