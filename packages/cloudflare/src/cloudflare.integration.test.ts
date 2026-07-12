import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { runtimeEventSchema, runtimeSnapshotSchema } from "@pear-agent/core";
import {
  initialOutingWorldState,
  outingDomain,
  outingGoal,
  outingPlan,
} from "../../../examples/outing-domain/src/domain.js";
import type { PearEnv } from "./env.js";
import { D1ExecutionStateRepository } from "./d1/repository.js";
import { D1ReplanStore } from "./replan/store.js";
import { summarizeSnapshotForVoice } from "./voice/tools.js";

const pearEnv = env as unknown as PearEnv;

function contextHeaders(extra?: HeadersInit): HeadersInit {
  return {
    "x-pear-context": JSON.stringify({
      actorId: "traveler",
      roles: ["owner"],
      claims: {},
    }),
    ...extra,
  };
}

async function createSession(sessionId: string, domainId = "outing"): Promise<Response> {
  return exports.default.fetch(
    new Request("http://example.com/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...contextHeaders(),
      },
      body: JSON.stringify({
        sessionId,
        domainId,
        actorIds: ["traveler"],
        goal: outingGoal,
        normalizedInput: {
          departureAt: "2026-07-11T03:00:00Z",
          belongings: [{ id: "phone", name: "Phone", chargePercent: 20 }],
        },
        worldState: initialOutingWorldState,
      }),
    }),
  );
}

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
        body: JSON.stringify({}),
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
        body: JSON.stringify({ handle: "gemini-handle-1" }),
      }),
    );
    expect(handleRes.status).toBe(200);
    const handleBody = (await handleRes.json()) as {
      lease: { providerResumeHandle: string | null };
    };
    expect(handleBody.lease.providerResumeHandle).toBe("gemini-handle-1");

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

  it("automatically applies a delay patch only to the affected subgraph", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const delayId = `${sessionId}-delay`;
    expect(
      (
        await exports.default.fetch(
          new Request(`http://example.com/sessions/${sessionId}/events`, {
            method: "POST",
            headers: { "content-type": "application/json", ...contextHeaders() },
            body: JSON.stringify({
              id: delayId,
              sessionId,
              idempotencyKey: "delay",
              actorId: "traveler",
              origin: "user",
              type: "domain_event",
              domainType: "delay",
              payload: { minutes: 10 },
              occurredAt: new Date().toISOString(),
            }),
          }),
        )
      ).status,
    ).toBe(200);

    const before = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/snapshot`, {
        headers: contextHeaders(),
      }),
    );
    const beforeBody = (await before.json()) as {
      snapshot: { plan: { steps: Array<{ id: string; estimatedDurationSeconds: number }> } };
    };
    const packBefore = beforeBody.snapshot.plan.steps.find(({ id }) => id === "pack");

    const response = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kind: string;
      affectedSubgraph: { stepIds: string[] };
      state: {
        plan: {
          version: number;
          steps: Array<{
            id: string;
            estimatedDurationSeconds: number;
            domainData: Record<string, unknown>;
          }>;
        };
        worldState: { resources: Array<{ id: string; state: unknown }> };
      };
    };
    expect(body.kind).toBe("applied");
    expect(body.affectedSubgraph.stepIds).toEqual(["charge"]);
    expect(body.state.plan.version).toBe(2);
    expect(body.state.plan.steps.find(({ id }) => id === "charge")?.estimatedDurationSeconds).toBe(
      360,
    );
    expect(body.state.plan.steps.find(({ id }) => id === "pack")).toEqual(packBefore);
    expect(body.state.plan.steps.find(({ id }) => id === "charge")?.domainData).toEqual({
      belongingIds: ["phone"],
    });
    expect(body.state.worldState.resources).toContainEqual({
      id: "plan-utilization",
      state: { requirementsByStep: { pack: [], charge: [] } },
    });

    const retry = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(retry.status).toBe(200);
    expect(
      ((await retry.json()) as { kind: string; state: { plan: { version: number } } }).state.plan
        .version,
    ).toBe(2);

    const versions = await pearEnv.DB.prepare(
      "SELECT COUNT(*) AS count, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count FROM plan_versions WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{ count: number; active_count: number }>();
    expect(versions).toEqual({ count: 2, active_count: 1 });
    const planUpdatedCount = await pearEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM runtime_events WHERE session_id = ? AND json_extract(event_json, '$.type') = 'plan_updated'",
    )
      .bind(sessionId)
      .first<{ count: number }>();
    expect(planUpdatedCount?.count).toBe(1);

    const snapshot = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/snapshot`, {
        headers: contextHeaders(),
      }),
    );
    const snapshotBody = (await snapshot.json()) as { snapshot: unknown };
    const parsedSnapshot = runtimeSnapshotSchema.parse(snapshotBody.snapshot);
    expect(parsedSnapshot.latestPlanChange?.status).toBe("applied");
    expect(parsedSnapshot.latestPlanChange?.patch.summary).toContain("Extend charging");
    expect(summarizeSnapshotForVoice(parsedSnapshot).latestPlanChange).toMatchObject({
      status: "applied",
      updatedStepIds: ["charge"],
    });
  });

  it("returns not_needed without creating a Patch when Assess finds no impact", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const response = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { kind: string }).kind).toBe("not_needed");
    const patches = await pearEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM plan_patches WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{ count: number }>();
    expect(patches?.count).toBe(0);
  });

  it("replays an applied confirmation after the Session and Domain have moved on", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-delay`,
          sessionId,
          idempotencyKey: "delay",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 5 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    const replanned = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    const replannedBody = (await replanned.json()) as {
      planChange: { patch: { id: string } };
    };
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-cancelled`,
          sessionId,
          idempotencyKey: "cancelled",
          actorId: "traveler",
          origin: "user",
          type: "session_cancelled",
          payload: {},
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    await pearEnv.DB.prepare("UPDATE execution_sessions SET domain_version = 999 WHERE id = ?")
      .bind(sessionId)
      .run();

    const replayed = await exports.default.fetch(
      new Request(
        `http://example.com/sessions/${sessionId}/plan-patches/${replannedBody.planChange.patch.id}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify({ confirmed: true }),
        },
      ),
    );
    expect(replayed.status).toBe(200);
    expect(
      (await replayed.json()) as { kind: string; state: { session: { status: string } } },
    ).toMatchObject({ kind: "applied", state: { session: { status: "cancelled" } } });
  });

  it("wakes an event Continuation from the internally committed plan_updated Event", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-delay`,
          sessionId,
          idempotencyKey: "delay",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 5 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    const suspended = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          wakeCondition: { type: "event", eventType: "plan_updated" },
          suspendedReason: "Wait for a revised plan",
          resumeDirective: "Explain the new plan",
        }),
      }),
    );
    expect(suspended.status).toBe(201);

    const replanned = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(replanned.status).toBe(200);
    const continuation = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuation`, {
        headers: contextHeaders(),
      }),
    );
    expect(
      ((await continuation.json()) as { continuation: { status: string } }).continuation.status,
    ).toBe("wake_pending");
  });

  it("retries delivery of a committed plan_updated Event after a missed Continuation wake", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const delayId = `${sessionId}-delay`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: delayId,
          sessionId,
          idempotencyKey: "delay",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 5 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          wakeCondition: { type: "event", eventType: "plan_updated" },
          suspendedReason: "Wait for a revised plan",
          resumeDirective: "Explain the new plan",
        }),
      }),
    );

    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    const snapshot = await agent.getSnapshot();
    expect(snapshot).not.toBeNull();
    const charge = snapshot!.plan.steps.find(({ id }) => id === "charge");
    expect(charge).toBeDefined();
    const committed = await new D1ReplanStore(pearEnv.DB).propose({
      sessionId,
      actorId: "traveler",
      mode: "automatic",
      patch: {
        id: `${sessionId}-direct-patch`,
        basePlanId: snapshot!.plan.id,
        basePlanVersion: snapshot!.plan.version,
        baseLastEventId: delayId,
        causeEventIds: [delayId],
        affectedStepIds: ["charge"],
        operations: [
          {
            type: "update_step",
            stepId: "charge",
            step: { ...charge!, estimatedDurationSeconds: charge!.estimatedDurationSeconds + 60 },
          },
        ],
        summary: "Direct commit used to simulate a lost post-commit wake",
      },
      candidateWorldState: snapshot!.worldState,
      expectedCauseEventIds: [delayId],
      expectedAffectedStepIds: ["charge"],
      capabilityPolicies: [],
      domainVersion: outingDomain.version,
      normalizedInputRevision: 1,
    });
    expect(committed.kind).toBe("applied");
    expect((await agent.getContinuation())?.status).toBe("suspended");

    const retry = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(retry.status).toBe(200);
    expect((await agent.getContinuation())?.status).toBe("wake_pending");
  });

  it("does not wake a newer Continuation when an old plan_updated Event is replayed", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-delay`,
          sessionId,
          idempotencyKey: "delay",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 5 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    expect(
      (
        await exports.default.fetch(
          new Request(`http://example.com/sessions/${sessionId}/replans`, {
            method: "POST",
            headers: { "content-type": "application/json", ...contextHeaders() },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(200);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          wakeCondition: { type: "event", eventType: "plan_updated" },
          suspendedReason: "Wait only for the next revised plan",
          resumeDirective: "Explain the next plan",
        }),
      }),
    );

    const retry = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(retry.status).toBe(200);
    const continuation = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuation`, {
        headers: contextHeaders(),
      }),
    );
    expect(
      ((await continuation.json()) as { continuation: { status: string } }).continuation.status,
    ).toBe("suspended");
  });

  it("retries a missed Continuation wake when a stable replan failure is duplicated", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const attemptId = `attempt-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          wakeCondition: { type: "event", eventType: "replan_failed" },
          suspendedReason: "Wait for a replan failure",
          resumeDirective: "Explain recovery options",
        }),
      }),
    );
    const failure = runtimeEventSchema.parse({
      id: `${sessionId}-replan-failed-${attemptId}`,
      sessionId,
      idempotencyKey: `replan-failed:${attemptId}`,
      actorId: "traveler",
      origin: "replan",
      type: "replan_failed",
      payload: { patchId: attemptId, reason: "Transient generator failure" },
      occurredAt: new Date(),
    });
    expect((await new D1ExecutionStateRepository(pearEnv.DB).appendEvent(failure)).kind).toBe(
      "applied",
    );

    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    expect((await agent.getContinuation())?.status).toBe("suspended");
    const retried = await agent.appendReplanFailure({
      actorId: "traveler",
      attemptId,
      reason: "Transient generator failure",
    });
    expect(retried.kind).toBe("duplicate");
    expect((await agent.getContinuation())?.status).toBe("wake_pending");
  });

  it("can confirm a Patch after replan_proposed wakes its Continuation", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId, "outing-confirm")).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-delay`,
          sessionId,
          idempotencyKey: "delay",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 5 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/continuations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          wakeCondition: { type: "event", eventType: "replan_proposed" },
          suspendedReason: "Review the proposed plan",
          resumeDirective: "Ask for confirmation",
        }),
      }),
    );
    const proposed = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    const proposedBody = (await proposed.json()) as {
      planChange: { patch: { id: string } };
    };

    const confirmed = await exports.default.fetch(
      new Request(
        `http://example.com/sessions/${sessionId}/plan-patches/${proposedBody.planChange.patch.id}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify({ confirmed: true }),
        },
      ),
    );
    expect(confirmed.status).toBe(200);
    expect(
      (await confirmed.json()) as { kind: string; state: { plan: { version: number } } },
    ).toMatchObject({ kind: "applied", state: { plan: { version: 2 } } });
  });

  it("keeps confirm and suggest patches inactive until their allowed lifecycle action", async () => {
    for (const mode of ["confirm", "suggest"] as const) {
      const sessionId = `session-${mode}-${crypto.randomUUID()}`;
      expect((await createSession(sessionId)).status).toBe(201);
      await exports.default.fetch(
        new Request(`http://example.com/sessions/${sessionId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify({
            id: `${sessionId}-delay`,
            sessionId,
            idempotencyKey: "delay",
            actorId: "traveler",
            origin: "user",
            type: "domain_event",
            domainType: "delay",
            payload: { minutes: 5 },
            occurredAt: new Date().toISOString(),
          }),
        }),
      );
      const proposed = await exports.default.fetch(
        new Request(`http://example.com/sessions/${sessionId}/replans`, {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify({ mode }),
        }),
      );
      const proposedBody = (await proposed.json()) as {
        kind: string;
        planChange: { patch: { id: string } };
        state: { plan: { version: number } };
      };
      expect(proposedBody.kind).toBe(mode === "confirm" ? "pending_confirmation" : "suggested");
      expect(proposedBody.state.plan.version).toBe(1);

      if (mode === "confirm") {
        const pendingSnapshotResponse = await exports.default.fetch(
          new Request(`http://example.com/sessions/${sessionId}/snapshot`, {
            headers: contextHeaders(),
          }),
        );
        const pendingSnapshot = runtimeSnapshotSchema.parse(
          ((await pendingSnapshotResponse.json()) as { snapshot: unknown }).snapshot,
        );
        expect(summarizeSnapshotForVoice(pendingSnapshot).latestPlanChange).toMatchObject({
          status: "pending_confirmation",
          effect: "proposed",
          mode: "confirm",
          targetPlanVersion: null,
        });
        const confirm = () =>
          exports.default.fetch(
            new Request(
              `http://example.com/sessions/${sessionId}/plan-patches/${proposedBody.planChange.patch.id}/confirm`,
              {
                method: "POST",
                headers: { "content-type": "application/json", ...contextHeaders() },
                body: JSON.stringify({ confirmed: true }),
              },
            ),
          );
        const confirmed = await Promise.all([confirm(), confirm()]);
        expect(confirmed.map(({ status }) => status)).toEqual([200, 200]);
        expect(
          await Promise.all(
            confirmed.map(async (response) => ((await response.json()) as { kind: string }).kind),
          ),
        ).toEqual(["applied", "applied"]);
        const rows = await pearEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM plan_versions WHERE session_id = ?) AS version_count,
             (SELECT COUNT(*) FROM plan_versions WHERE session_id = ? AND status = 'active') AS active_count,
             (SELECT COUNT(*) FROM runtime_events WHERE session_id = ? AND json_extract(event_json, '$.type') = 'plan_updated') AS event_count,
             (SELECT plan_version FROM execution_sessions WHERE id = ?) AS session_version,
             (SELECT json_extract(state_json, '$.plan.version') FROM materialized_states WHERE session_id = ?) AS state_version,
             (SELECT json_extract(plan_json, '$.version') FROM plan_versions WHERE session_id = ? AND status = 'active') AS stored_plan_version`,
        )
          .bind(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId)
          .first<{
            version_count: number;
            active_count: number;
            event_count: number;
            session_version: number;
            state_version: number;
            stored_plan_version: number;
          }>();
        expect(rows).toEqual({
          version_count: 2,
          active_count: 1,
          event_count: 1,
          session_version: 2,
          state_version: 2,
          stored_plan_version: 2,
        });
      } else {
        const rejected = await exports.default.fetch(
          new Request(
            `http://example.com/sessions/${sessionId}/plan-patches/${proposedBody.planChange.patch.id}/confirm`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...contextHeaders() },
              body: JSON.stringify({ confirmed: true }),
            },
          ),
        );
        expect(rejected.status).toBe(409);
      }
    }
  });

  it("does not let a request weaken the Domain default Replan mode", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId, "outing-confirm")).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-delay`,
          sessionId,
          idempotencyKey: "delay",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 5 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );

    const response = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({ mode: "automatic" }),
      }),
    );
    const body = (await response.json()) as {
      kind: string;
      planChange: { mode: string };
      state: { plan: { version: number } };
    };
    expect(body.kind).toBe("pending_confirmation");
    expect(body.planChange.mode).toBe("confirm");
    expect(body.state.plan.version).toBe(1);
  });

  it("authorizes a Replan before generation or durable mutation", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const response = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pear-deny": "1",
          ...contextHeaders(),
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    const rows = await pearEnv.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM plan_patches WHERE session_id = ?) AS patch_count,
         (SELECT COUNT(*) FROM runtime_events WHERE session_id = ? AND json_extract(event_json, '$.type') LIKE 'replan_%') AS event_count`,
    )
      .bind(sessionId, sessionId)
      .first<{ patch_count: number; event_count: number }>();
    expect(rows).toEqual({ patch_count: 0, event_count: 0 });
  });

  it("records an invalid patch failure and blocks direct plan_updated events", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    const failed = await agent.proposeReplan({
      actorId: "traveler",
      mode: "automatic",
      domainVersion: 1,
      normalizedInputRevision: 1,
      candidateWorldState: initialOutingWorldState,
      capabilityPolicies: [],
      expectedCauseEventIds: ["missing-event"],
      expectedAffectedStepIds: ["pack"],
      patch: {
        id: `${sessionId}-invalid-patch`,
        basePlanId: "outing-plan",
        basePlanVersion: 1,
        baseLastEventId: null,
        causeEventIds: ["missing-event"],
        affectedStepIds: ["pack"],
        operations: [{ type: "remove_step", stepId: "pack" }],
        summary: "Invalid patch",
      },
    });
    expect(failed.kind).toBe("failed");
    expect(failed.state.plan.version).toBe(1);
    expect(failed.change.failureReason).toContain("Unknown cause event");
    const failedSnapshotResponse = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/snapshot`, {
        headers: contextHeaders(),
      }),
    );
    const failedSnapshot = runtimeSnapshotSchema.parse(
      ((await failedSnapshotResponse.json()) as { snapshot: unknown }).snapshot,
    );
    expect(summarizeSnapshotForVoice(failedSnapshot).latestPlanChange).toMatchObject({
      effect: "rejected",
      failureReason: expect.stringContaining("Unknown cause event"),
      causeEventIds: ["missing-event"],
    });

    const direct = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-forged-plan-update`,
          sessionId,
          idempotencyKey: "forged-plan-update",
          actorId: "traveler",
          origin: "user",
          type: "plan_updated",
          payload: { plan: outingPlan },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    expect(direct.status).toBe(400);
    expect((await agent.getState())?.plan.version).toBe(1);
    expect(
      (
        await pearEnv.DB.prepare("SELECT COUNT(*) AS count FROM plan_versions WHERE session_id = ?")
          .bind(sessionId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it("rejects an Agent patch that expands the Runtime-approved affected subgraph", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const delayId = `${sessionId}-delay`;
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: delayId,
          sessionId,
          idempotencyKey: "delay",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 5 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    const charge = outingPlan.steps.find(({ id }) => id === "charge")!;

    const result = await agent.proposeReplan({
      actorId: "traveler",
      mode: "automatic",
      domainVersion: 1,
      normalizedInputRevision: 1,
      candidateWorldState: initialOutingWorldState,
      capabilityPolicies: [],
      expectedCauseEventIds: [delayId],
      expectedAffectedStepIds: ["charge"],
      patch: {
        id: `${sessionId}-expanded-patch`,
        basePlanId: outingPlan.id,
        basePlanVersion: outingPlan.version,
        baseLastEventId: delayId,
        causeEventIds: [delayId],
        affectedStepIds: ["charge", "pack"],
        operations: [
          {
            type: "update_step",
            stepId: "charge",
            step: { ...charge, estimatedDurationSeconds: 600 },
          },
        ],
        summary: "Attempt to expand impact",
      },
    });

    expect(result.kind).toBe("failed");
    expect(result.change.failureReason).toContain("Runtime-approved subgraph");
    expect(result.state.plan.version).toBe(1);
  });

  it("retries the same cause after a failed attempt on a newer operational cursor", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const delayId = `${sessionId}-delay`;
    const observationId = `${sessionId}-observation`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: delayId,
          sessionId,
          idempotencyKey: "delay",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 5 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    const before = await agent.getState();
    expect(before).not.toBeNull();
    const charge = before!.plan.steps.find(({ id }) => id === "charge");
    expect(charge).toBeDefined();
    const store = new D1ReplanStore(pearEnv.DB);
    const failed = await store.propose({
      sessionId,
      actorId: "traveler",
      mode: "automatic",
      patch: {
        id: `${sessionId}-failed-attempt`,
        basePlanId: before!.plan.id,
        basePlanVersion: 99,
        baseLastEventId: delayId,
        causeEventIds: [delayId],
        affectedStepIds: ["charge"],
        operations: [
          {
            type: "update_step",
            stepId: "charge",
            step: { ...charge!, estimatedDurationSeconds: charge!.estimatedDurationSeconds + 60 },
          },
        ],
        summary: "Deliberately stale attempt",
      },
      candidateWorldState: before!.worldState,
      expectedCauseEventIds: [delayId],
      expectedAffectedStepIds: ["charge"],
      capabilityPolicies: [],
      domainVersion: outingDomain.version,
      normalizedInputRevision: 1,
    });
    expect(failed.kind).toBe("failed");

    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: observationId,
          sessionId,
          idempotencyKey: "observation",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "observation",
          payload: {},
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    const afterEvent = await agent.getState();
    expect(afterEvent).not.toBeNull();
    const applied = await store.propose({
      sessionId,
      actorId: "traveler",
      mode: "automatic",
      patch: {
        id: `${sessionId}-recovered-attempt`,
        basePlanId: afterEvent!.plan.id,
        basePlanVersion: afterEvent!.plan.version,
        baseLastEventId: observationId,
        causeEventIds: [delayId],
        affectedStepIds: ["charge"],
        operations: [
          {
            type: "update_step",
            stepId: "charge",
            step: {
              ...charge!,
              estimatedDurationSeconds: charge!.estimatedDurationSeconds + 60,
            },
          },
        ],
        summary: "Recovered attempt on the new cursor",
      },
      candidateWorldState: afterEvent!.worldState,
      expectedCauseEventIds: [delayId],
      expectedAffectedStepIds: ["charge"],
      capabilityPolicies: [],
      domainVersion: outingDomain.version,
      normalizedInputRevision: 1,
    });
    expect(applied.kind).toBe("applied");
    expect(applied.state.plan.version).toBe(2);
    const attempts = await pearEnv.DB.prepare(
      "SELECT status FROM plan_patches WHERE session_id = ? ORDER BY rowid ASC",
    )
      .bind(sessionId)
      .all<{ status: string }>();
    expect(attempts.results.map(({ status }) => status)).toEqual(["failed", "applied"]);
  });

  it("sanitizes generator failures and keeps the old Plan Version active", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-provider-failure`,
          sessionId,
          idempotencyKey: "provider-failure",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 999 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );

    const response = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(response.status).toBe(422);
    const responseText = await response.text();
    expect(responseText).toContain("Replan assessment generation failed");
    expect(responseText).not.toContain("do-not-persist");
    const retry = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(retry.status).toBe(422);
    const persisted = await pearEnv.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM plan_versions WHERE session_id = ?) AS version_count,
         (SELECT COUNT(*) FROM plan_versions WHERE session_id = ? AND status = 'active') AS active_count,
         (SELECT COUNT(*) FROM runtime_events WHERE session_id = ? AND json_extract(event_json, '$.type') = 'replan_failed') AS failure_count,
         (SELECT event_json FROM runtime_events WHERE session_id = ? AND json_extract(event_json, '$.type') = 'replan_failed' ORDER BY rowid DESC LIMIT 1) AS failure_event`,
    )
      .bind(sessionId, sessionId, sessionId, sessionId)
      .first<{
        version_count: number;
        active_count: number;
        failure_count: number;
        failure_event: string;
      }>();
    expect(persisted?.version_count).toBe(1);
    expect(persisted?.active_count).toBe(1);
    expect(persisted?.failure_count).toBe(1);
    expect(persisted?.failure_event).toContain("Replan assessment generation failed");
    expect(persisted?.failure_event).not.toContain("do-not-persist");
  });

  it("rejects a Patch assessed from stale normalized input and allows the new revision", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const delayId = `${sessionId}-delay`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: delayId,
          sessionId,
          idempotencyKey: "delay",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 5 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    const state = await agent.getState();
    expect(state).not.toBeNull();
    const charge = state!.plan.steps.find(({ id }) => id === "charge");
    expect(charge).toBeDefined();
    await agent.putNormalizedInput({ departureAt: "2026-07-11T04:00:00Z" });
    expect((await agent.getNormalizedInputRecord())?.revision).toBe(2);

    const store = new D1ReplanStore(pearEnv.DB);
    const patchForRevision = (id: string) => ({
      id,
      basePlanId: state!.plan.id,
      basePlanVersion: state!.plan.version,
      baseLastEventId: delayId,
      causeEventIds: [delayId],
      affectedStepIds: ["charge"],
      operations: [
        {
          type: "update_step" as const,
          stepId: "charge",
          step: { ...charge!, estimatedDurationSeconds: charge!.estimatedDurationSeconds + 60 },
        },
      ],
      summary: "Update charging for the normalized departure input",
    });
    const stale = await store.propose({
      sessionId,
      actorId: "traveler",
      mode: "automatic",
      patch: patchForRevision(`${sessionId}-stale-input`),
      candidateWorldState: state!.worldState,
      expectedCauseEventIds: [delayId],
      expectedAffectedStepIds: ["charge"],
      capabilityPolicies: [],
      domainVersion: outingDomain.version,
      normalizedInputRevision: 1,
    });
    expect(stale.kind).toBe("failed");
    expect(stale.change.failureReason).toContain("Normalized input changed");
    expect(stale.state.plan.version).toBe(1);

    const current = await store.propose({
      sessionId,
      actorId: "traveler",
      mode: "automatic",
      patch: patchForRevision(`${sessionId}-current-input`),
      candidateWorldState: state!.worldState,
      expectedCauseEventIds: [delayId],
      expectedAffectedStepIds: ["charge"],
      capabilityPolicies: [],
      domainVersion: outingDomain.version,
      normalizedInputRevision: 2,
    });
    expect(current.kind).toBe("applied");
    expect(current.change.validationNormalizedInputRevision).toBe(2);
    expect(current.state.plan.version).toBe(2);
  });

  it("rejects a Patch whose requirements conflict with WorldState resources", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-missing-resource`,
          sessionId,
          idempotencyKey: "missing-resource",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 777 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );

    const response = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Unavailable WorldState resource battery");
    const stateResponse = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}`, { headers: contextHeaders() }),
    );
    expect(
      ((await stateResponse.json()) as { state: { plan: { version: number } } }).state.plan.version,
    ).toBe(1);
  });

  it("fails a pending Patch when the Session Domain version changes", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-delay`,
          sessionId,
          idempotencyKey: "delay",
          actorId: "traveler",
          origin: "user",
          type: "domain_event",
          domainType: "delay",
          payload: { minutes: 5 },
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    const proposed = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({ mode: "confirm" }),
      }),
    );
    const patchId = ((await proposed.json()) as { planChange: { patch: { id: string } } })
      .planChange.patch.id;
    await pearEnv.DB.prepare("UPDATE execution_sessions SET domain_version = 2 WHERE id = ?")
      .bind(sessionId)
      .run();

    const confirmed = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/plan-patches/${patchId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({ confirmed: true }),
      }),
    );
    expect(confirmed.status).toBe(200);
    const body = (await confirmed.json()) as {
      kind: string;
      planChange: { status: string; failureReason: string };
      state: { plan: { version: number } };
    };
    expect(body.kind).toBe("failed");
    expect(body.planChange.status).toBe("failed");
    expect(body.planChange.failureReason).toContain("Domain version");
    expect(body.state.plan.version).toBe(1);
  });

  it("does not assess an existing Session with an incompatible Domain version", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    await pearEnv.DB.prepare("UPDATE execution_sessions SET domain_version = 2 WHERE id = ?")
      .bind(sessionId)
      .run();

    const response = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Domain version is incompatible");
    const failureCount = await pearEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM runtime_events WHERE session_id = ? AND json_extract(event_json, '$.type') = 'replan_failed'",
    )
      .bind(sessionId)
      .first<{ count: number }>();
    expect(failureCount?.count).toBe(1);
  });

  it("rejects replanning a terminal Session before generation", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          id: `${sessionId}-cancel`,
          sessionId,
          idempotencyKey: "cancel",
          actorId: "traveler",
          origin: "user",
          type: "session_cancelled",
          payload: {},
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    const response = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(response.status).toBe(409);
    const patches = await pearEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM plan_patches WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{ count: number }>();
    expect(patches?.count).toBe(0);
  });

  it("rejects replanning a completed Session before generation", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    for (const criterionId of ["packed", "charged"]) {
      await exports.default.fetch(
        new Request(`http://example.com/sessions/${sessionId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify({
            id: `${sessionId}-${criterionId}`,
            sessionId,
            idempotencyKey: `evaluate-${criterionId}`,
            actorId: "traveler",
            origin: "system",
            type: "goal_evaluated",
            payload: { criterionId, status: "satisfied", evidence: [] },
            occurredAt: new Date().toISOString(),
          }),
        }),
      );
    }
    const response = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    expect(response.status).toBe(409);
  });

  it("treats a newly appended backdated Event as a stale Patch boundary", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const appendDomainEvent = (id: string, occurredAt: string) =>
      exports.default.fetch(
        new Request(`http://example.com/sessions/${sessionId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify({
            id,
            sessionId,
            idempotencyKey: id,
            actorId: "traveler",
            origin: "user",
            type: "domain_event",
            domainType: "delay",
            payload: { minutes: 5 },
            occurredAt,
          }),
        }),
      );
    const assessedEventId = `${sessionId}-assessed`;
    const backdatedEventId = `${sessionId}-backdated`;
    await appendDomainEvent(assessedEventId, "2030-01-01T00:00:00.000Z");
    await appendDomainEvent(backdatedEventId, "2020-01-01T00:00:00.000Z");
    const snapshotResponse = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/snapshot`, {
        headers: contextHeaders(),
      }),
    );
    const snapshot = runtimeSnapshotSchema.parse(
      ((await snapshotResponse.json()) as { snapshot: unknown }).snapshot,
    );
    expect(snapshot.recentEvents.at(-1)?.id).toBe(backdatedEventId);
    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    const charge = outingPlan.steps.find(({ id }) => id === "charge")!;

    const result = await agent.proposeReplan({
      actorId: "traveler",
      mode: "automatic",
      domainVersion: 1,
      normalizedInputRevision: 1,
      candidateWorldState: initialOutingWorldState,
      capabilityPolicies: [],
      expectedCauseEventIds: [assessedEventId],
      expectedAffectedStepIds: ["charge"],
      patch: {
        id: `${sessionId}-stale-patch`,
        basePlanId: outingPlan.id,
        basePlanVersion: 1,
        baseLastEventId: assessedEventId,
        causeEventIds: [assessedEventId],
        affectedStepIds: ["charge"],
        operations: [
          {
            type: "update_step",
            stepId: "charge",
            step: { ...charge, estimatedDurationSeconds: 600 },
          },
        ],
        summary: "Stale after a backdated event",
      },
    });

    expect(result.kind).toBe("failed");
    expect(result.change.failureReason).toContain("event cursor is stale");
    expect(result.state.plan.version).toBe(1);
  });

  it("allows only one of two automatic Patches sharing a base Plan Version", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const eventIds = [`${sessionId}-cause-1`, `${sessionId}-cause-2`];
    for (const [index, id] of eventIds.entries()) {
      await exports.default.fetch(
        new Request(`http://example.com/sessions/${sessionId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify({
            id,
            sessionId,
            idempotencyKey: id,
            actorId: "traveler",
            origin: "user",
            type: "domain_event",
            domainType: "delay",
            payload: { minutes: index + 1 },
            occurredAt: new Date(Date.now() + index).toISOString(),
          }),
        }),
      );
    }
    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    const charge = outingPlan.steps.find(({ id }) => id === "charge")!;
    const current = await agent.getState();
    const propose = (index: number) =>
      agent.proposeReplan({
        actorId: "traveler",
        mode: "automatic",
        domainVersion: 1,
        normalizedInputRevision: 1,
        candidateWorldState: current!.worldState,
        capabilityPolicies: [],
        expectedCauseEventIds: [eventIds[index]!],
        expectedAffectedStepIds: ["charge"],
        patch: {
          id: `${sessionId}-competing-${index}`,
          basePlanId: outingPlan.id,
          basePlanVersion: 1,
          baseLastEventId: eventIds[1]!,
          causeEventIds: [eventIds[index]!],
          affectedStepIds: ["charge"],
          operations: [
            {
              type: "update_step",
              stepId: "charge",
              step: { ...charge, estimatedDurationSeconds: 600 + index },
            },
          ],
          summary: `Competing patch ${index}`,
        },
      });

    const results = await Promise.all([propose(0), propose(1)]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["applied", "failed"]);
    const persisted = await pearEnv.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM plan_versions WHERE session_id = ?) AS version_count,
         (SELECT COUNT(*) FROM plan_versions WHERE session_id = ? AND status = 'active') AS active_count,
         (SELECT COUNT(*) FROM runtime_events WHERE session_id = ? AND json_extract(event_json, '$.type') = 'plan_updated') AS update_count`,
    )
      .bind(sessionId, sessionId, sessionId)
      .first<{ version_count: number; active_count: number; update_count: number }>();
    expect(persisted).toEqual({ version_count: 2, active_count: 1, update_count: 1 });
  });

  it("requires explicit interruption and confirmation before changing an active step", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const append = (event: Record<string, unknown>) =>
      exports.default.fetch(
        new Request(`http://example.com/sessions/${sessionId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify({
            sessionId,
            actorId: "traveler",
            origin: "user",
            occurredAt: new Date().toISOString(),
            ...event,
          }),
        }),
      );
    await append({
      id: `${sessionId}-start`,
      idempotencyKey: "start",
      type: "session_started",
      payload: {},
    });
    await append({
      id: `${sessionId}-charge-start`,
      idempotencyKey: "charge-start",
      type: "step_started",
      payload: { stepId: "charge" },
    });
    await append({
      id: `${sessionId}-timer-start`,
      idempotencyKey: "timer-start",
      type: "timer_started",
      payload: { timerId: "charge-timer", durationSeconds: 300 },
    });
    await append({
      id: `${sessionId}-delay`,
      idempotencyKey: "delay",
      type: "domain_event",
      domainType: "delay",
      payload: { minutes: 5 },
    });

    const proposed = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    const proposedBody = (await proposed.json()) as {
      kind: string;
      planChange: { patch: { id: string } };
    };
    expect(proposedBody.kind).toBe("pending_confirmation");

    const confirmUrl = `http://example.com/sessions/${sessionId}/plan-patches/${proposedBody.planChange.patch.id}/confirm`;
    const early = await exports.default.fetch(
      new Request(confirmUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({ confirmed: true }),
      }),
    );
    expect(((await early.json()) as { kind: string }).kind).toBe("pending_confirmation");

    await append({
      id: `${sessionId}-charge-pause`,
      idempotencyKey: "charge-pause",
      type: "step_paused",
      payload: { stepId: "charge" },
    });
    await append({
      id: `${sessionId}-session-pause`,
      idempotencyKey: "session-pause",
      type: "session_paused",
      payload: {},
    });
    const timerStillRunning = await exports.default.fetch(
      new Request(confirmUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({ confirmed: true }),
      }),
    );
    expect(((await timerStillRunning.json()) as { kind: string }).kind).toBe(
      "pending_confirmation",
    );
    await append({
      id: `${sessionId}-timer-pause`,
      idempotencyKey: "timer-pause",
      type: "timer_paused",
      payload: { timerId: "charge-timer" },
    });
    const confirmed = await exports.default.fetch(
      new Request(confirmUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({ confirmed: true }),
      }),
    );
    const confirmedBody = (await confirmed.json()) as {
      kind: string;
      state: { plan: { version: number }; stepStates: Record<string, { status: string }> };
    };
    expect(confirmedBody.kind).toBe("applied");
    expect(confirmedBody.state.plan.version).toBe(2);
    expect(confirmedBody.state.stepStates.charge?.status).not.toBe("active");
    const updateRow = await pearEnv.DB.prepare(
      "SELECT event_json FROM runtime_events WHERE session_id = ? AND json_extract(event_json, '$.type') = 'plan_updated'",
    )
      .bind(sessionId)
      .first<{ event_json: string }>();
    expect(
      (JSON.parse(updateRow!.event_json) as { payload: { confirmedActiveStepIds: string[] } })
        .payload.confirmedActiveStepIds,
    ).toEqual(["charge"]);
  });

  it("does not hide a backdated concurrent Event inside active-step interruption", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    const append = (event: Record<string, unknown>) =>
      exports.default.fetch(
        new Request(`http://example.com/sessions/${sessionId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json", ...contextHeaders() },
          body: JSON.stringify({
            sessionId,
            actorId: "traveler",
            origin: "user",
            occurredAt: "2030-01-01T00:00:00.000Z",
            ...event,
          }),
        }),
      );
    await append({
      id: `${sessionId}-start`,
      idempotencyKey: "start",
      type: "session_started",
      payload: {},
    });
    await append({
      id: `${sessionId}-charge-start`,
      idempotencyKey: "charge-start",
      type: "step_started",
      payload: { stepId: "charge" },
    });
    await append({
      id: `${sessionId}-delay`,
      idempotencyKey: "delay",
      type: "domain_event",
      domainType: "delay",
      payload: { minutes: 5 },
    });
    const proposed = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/replans`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: "{}",
      }),
    );
    const patchId = ((await proposed.json()) as { planChange: { patch: { id: string } } })
      .planChange.patch.id;

    await append({
      id: `${sessionId}-backdated-observation`,
      idempotencyKey: "backdated-observation",
      type: "domain_event",
      domainType: "weather",
      payload: { changed: true },
      occurredAt: "2020-01-01T00:00:00.000Z",
    });
    await append({
      id: `${sessionId}-charge-pause`,
      idempotencyKey: "charge-pause",
      type: "step_paused",
      payload: { stepId: "charge" },
    });
    await append({
      id: `${sessionId}-session-pause`,
      idempotencyKey: "session-pause",
      type: "session_paused",
      payload: {},
    });

    const confirmed = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/plan-patches/${patchId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({ confirmed: true }),
      }),
    );
    const confirmedBody = (await confirmed.json()) as {
      kind: string;
      state: { plan: { version: number } };
    };
    expect(confirmedBody.kind).toBe("failed");
    expect(confirmedBody.state.plan.version).toBe(1);
  });
});
