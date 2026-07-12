import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { runtimeSnapshotSchema } from "@pear-agent/core";
import {
  initialOutingWorldState,
  outingDomain,
  outingPlan,
} from "../../../../examples/outing-domain/src/domain.js";
import { D1ReplanStore } from "./store.js";
import { contextHeaders, createSession, pearEnv } from "../test/integration-helpers.js";

describe("cloudflare replan modes and races", () => {
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
    const { getExecutionSessionAgent } = await import("../agent/client.js");
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
    const { getExecutionSessionAgent } = await import("../agent/client.js");
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
    const { getExecutionSessionAgent } = await import("../agent/client.js");
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
    const { getExecutionSessionAgent } = await import("../agent/client.js");
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
    const { getExecutionSessionAgent } = await import("../agent/client.js");
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
