import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  initialOutingWorldState,
  outingGoal,
} from "../../../../examples/outing-domain/src/domain.js";
import type { PearEnv } from "../env.js";
import { contextHeaders } from "../test/integration-helpers.js";

const pearEnv = env as unknown as PearEnv;

async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(
    new Request(`http://example.com${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...contextHeaders(init?.headers),
      },
    }),
  );
}

describe("plan library (CE-11)", () => {
  it("creates draft, generates from normalized input, marks ready, starts session", async () => {
    const createRes = await fetchApi("/plans", {
      method: "POST",
      body: JSON.stringify({
        domainId: "outing",
        goal: outingGoal,
        title: "Weekend outing",
        normalizedInput: {
          departureAt: "2026-07-11T03:00:00Z",
          belongings: [{ id: "phone", name: "Phone", chargePercent: 20 }],
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      artifact: { id: string; status: string; version: number; currentPlan: { steps: unknown[] } };
    };
    expect(created.artifact.status).toBe("draft");
    expect(created.artifact.currentPlan.steps).toEqual([]);

    const planId = created.artifact.id;

    const genRes = await fetchApi(`/plans/${planId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(genRes.status).toBe(200);
    const generated = (await genRes.json()) as {
      artifact: {
        version: number;
        currentPlan: { steps: { id: string }[]; title?: string };
        normalizedInput: unknown;
      };
    };
    // Test worker uses static outingPlan fixture (not buildOutingPlan from input).
    expect(generated.artifact.currentPlan.steps.length).toBeGreaterThan(0);
    expect(generated.artifact.version).toBe(1);

    const readyRes = await fetchApi(`/plans/${planId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ready" }),
    });
    expect(readyRes.status).toBe(200);
    const ready = (await readyRes.json()) as { artifact: { status: string } };
    expect(ready.artifact.status).toBe("ready");

    const listRes = await fetchApi("/plans?domainId=outing");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { plans: { id: string; status: string }[] };
    expect(list.plans.some((p) => p.id === planId && p.status === "ready")).toBe(true);

    const sessionId = `plan-lib-${crypto.randomUUID()}`;
    const sessionRes = await fetchApi("/sessions", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        domainId: "outing",
        actorIds: ["traveler"],
        planArtifactId: planId,
        worldState: initialOutingWorldState,
      }),
    });
    expect(sessionRes.status).toBe(201);
    const sessionBody = (await sessionRes.json()) as {
      sessionId: string;
      planArtifactId: string;
      plan: { steps: unknown[] };
    };
    expect(sessionBody.sessionId).toBe(sessionId);
    expect(sessionBody.planArtifactId).toBe(planId);
    expect(sessionBody.plan.steps.length).toBeGreaterThan(0);

    // Reject starting from draft
    const draftRes = await fetchApi("/plans", {
      method: "POST",
      body: JSON.stringify({ domainId: "outing", goal: outingGoal, title: "Still drafting" }),
    });
    const draft = (await draftRes.json()) as { artifact: { id: string } };
    const badSession = await fetchApi("/sessions", {
      method: "POST",
      body: JSON.stringify({
        domainId: "outing",
        actorIds: ["traveler"],
        planArtifactId: draft.artifact.id,
      }),
    });
    expect(badSession.status).toBe(400);

    void pearEnv;
  });

  it("rejects session from missing plan artifact", async () => {
    const res = await fetchApi("/sessions", {
      method: "POST",
      body: JSON.stringify({
        domainId: "outing",
        actorIds: ["traveler"],
        planArtifactId: "does-not-exist",
      }),
    });
    expect(res.status).toBe(404);
  });
});
