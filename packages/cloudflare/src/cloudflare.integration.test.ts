import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { outingGoal } from "../../../examples/outing-domain/src/domain.js";
import type { PearEnv } from "./env.js";

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

async function createSession(sessionId: string): Promise<Response> {
  return exports.default.fetch(
    new Request("http://example.com/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...contextHeaders(),
      },
      body: JSON.stringify({
        sessionId,
        domainId: "outing",
        actorIds: ["traveler"],
        goal: outingGoal,
        normalizedInput: {
          departureAt: "2026-07-11T03:00:00Z",
          belongings: [{ id: "phone", name: "Phone", chargePercent: 20 }],
        },
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

  it("publishes JSON-safe snapshot on Agent sync state after mutations", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);

    const { getExecutionSessionAgent } = await import("./agent/client.js");
    const agent = await getExecutionSessionAgent(pearEnv, sessionId);
    const afterCreate = await agent.getSyncState();
    expect(afterCreate.revision).toBeGreaterThan(0);
    expect(afterCreate.continuation).toBeNull();
    expect(afterCreate.snapshot).toMatchObject({
      session: { id: sessionId, status: "not_started" },
    });

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
    expect(afterEvent.snapshot).toMatchObject({
      session: { id: sessionId, status: "active" },
    });
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
});
