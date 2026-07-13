import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { runtimeEventSchema, runtimeSnapshotSchema } from "@pear-agent/core";
import {
  initialOutingWorldState,
  outingDomain,
  outingPlan,
} from "../../../../examples/outing-domain/src/domain.js";
import { D1ExecutionStateRepository } from "../d1/repository.js";
import { D1ReplanStore } from "./store.js";
import { contextHeaders, createSession, pearEnv } from "../test/integration-helpers.js";
import { summarizeSnapshotForVoice } from "../voice/tools.js";

describe("cloudflare replan integration", () => {
  it("lets a Live tool record a delay and request Runtime replanning", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    expect((await createSession(sessionId)).status).toBe(201);
    expect(
      (
        await exports.default.fetch(
          new Request(`http://example.com/sessions/${sessionId}/voice/lease`, {
            method: "POST",
            headers: { "content-type": "application/json", ...contextHeaders() },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(201);

    const report = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/tools`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          toolName: "report_domain_event",
          args: { domainType: "delay", payload: { minutes: 15 } },
          callId: `delay-${crypto.randomUUID()}`,
        }),
      }),
    );
    expect(report.status).toBe(200);
    expect(((await report.json()) as { ok: boolean }).ok).toBe(true);

    const replan = await exports.default.fetch(
      new Request(`http://example.com/sessions/${sessionId}/voice/tools`, {
        method: "POST",
        headers: { "content-type": "application/json", ...contextHeaders() },
        body: JSON.stringify({
          toolName: "request_replan",
          args: { mode: "automatic" },
          callId: `replan-${crypto.randomUUID()}`,
        }),
      }),
    );
    expect(replan.status).toBe(200);
    const body = (await replan.json()) as {
      ok: boolean;
      result: { kind: string; state: { plan: { version: number } } };
    };
    expect(body.ok).toBe(true);
    expect(body.result.kind).toBe("applied");
    expect(body.result.state.plan.version).toBe(2);
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
      kind: "charge",
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
      effect: "applied",
      summary: expect.stringContaining("Extend charging"),
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

    const { getExecutionSessionAgent } = await import("../agent/client.js");
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
      payload: { attemptId, reason: "Transient generator failure" },
      occurredAt: new Date(),
    });
    expect((await new D1ExecutionStateRepository(pearEnv.DB).appendEvent(failure)).kind).toBe(
      "applied",
    );

    const { getExecutionSessionAgent } = await import("../agent/client.js");
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
    const { getExecutionSessionAgent } = await import("../agent/client.js");
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
});
