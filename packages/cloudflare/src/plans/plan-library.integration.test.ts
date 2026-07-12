import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  initialOutingWorldState,
  outingGoal,
  outingPlan,
} from "../../../../examples/outing-domain/src/domain.js";
import type { PearEnv } from "../env.js";
import { contextHeaders } from "../test/integration-helpers.js";

const pearEnv = env as unknown as PearEnv;

/** A different goal for mismatch tests — same structure, different id. */
const otherGoal = {
  ...outingGoal,
  id: "other-goal",
};

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
    // First generate always bumps past the empty draft shell (v1 → v2).
    expect(generated.artifact.currentPlan.steps.length).toBeGreaterThan(0);
    expect(generated.artifact.version).toBe(2);

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

  // --- Fix B: POST /plans with body.plan but mismatched body.goal returns 400 ---
  it("rejects POST /plans with plan.goal mismatching body.goal", async () => {
    const res = await fetchApi("/plans", {
      method: "POST",
      body: JSON.stringify({
        domainId: "outing",
        goal: otherGoal,
        plan: outingPlan,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toMatch(/goal must match/i);
  });

  // --- Fix C: PATCH /plans/:id with differing goal returns 400 ---
  it("rejects PATCH /plans/:id replacing plan with a different goal", async () => {
    // First create a plan
    const createRes = await fetchApi("/plans", {
      method: "POST",
      body: JSON.stringify({
        domainId: "outing",
        goal: outingGoal,
        title: "Test patch goal mismatch",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { artifact: { id: string } };
    const planId = created.artifact.id;

    // Replace plan with a mismatched goal
    const otherPlan = { ...outingPlan, goal: otherGoal };
    const patchRes = await fetchApi(`/plans/${planId}`, {
      method: "PATCH",
      body: JSON.stringify({ plan: otherPlan }),
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.text();
    expect(body).toMatch(/goal must match/i);
  });

  // --- Fix D: POST /plans without plan but with normalizedInput stores atomically ---
  it("POST /plans without plan stores normalizedInput atomically", async () => {
    const normalizedInput = {
      departureAt: "2026-07-11T03:00:00Z",
      belongings: [{ id: "phone", name: "Phone", chargePercent: 20 }],
    };
    const createRes = await fetchApi("/plans", {
      method: "POST",
      body: JSON.stringify({
        domainId: "outing",
        goal: outingGoal,
        title: "Atomic normalized",
        normalizedInput,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      artifact: { id: string; normalizedInput: unknown };
    };
    expect(created.artifact.normalizedInput).toEqual(normalizedInput);

    // GET should also return it
    const planId = created.artifact.id;
    const getRes = await fetchApi(`/plans/${planId}`);
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as { artifact: { normalizedInput: unknown } };
    expect(got.artifact.normalizedInput).toEqual(normalizedInput);
  });

  // --- Fix G: changeReason conditional on regeneration ---
  it("records changeReason initial on first generate and improve on regenerate", async () => {
    // Create draft
    const createRes = await fetchApi("/plans", {
      method: "POST",
      body: JSON.stringify({
        domainId: "outing",
        goal: outingGoal,
        title: "Change reason test",
        normalizedInput: {
          departureAt: "2026-07-11T03:00:00Z",
          belongings: [{ id: "phone", name: "Phone", chargePercent: 20 }],
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { artifact: { id: string } };
    const planId = created.artifact.id;

    // First generate (draft → generated, steps were empty → "initial")
    const gen1Res = await fetchApi(`/plans/${planId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(gen1Res.status).toBe(200);

    // Check version history — first gen should have changeReason "initial"
    const versionsRes1 = await fetchApi(`/plans/${planId}/versions`);
    expect(versionsRes1.status).toBe(200);
    const versions1 = (await versionsRes1.json()) as {
      versions: { changeReason: string }[];
    };
    const last1 = versions1.versions[0];
    expect(last1.changeReason).toBe("initial");

    // Second generate (plan had steps → "improve")
    const gen2Res = await fetchApi(`/plans/${planId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(gen2Res.status).toBe(200);

    const versionsRes2 = await fetchApi(`/plans/${planId}/versions`);
    expect(versionsRes2.status).toBe(200);
    const versions2 = (await versionsRes2.json()) as {
      versions: { changeReason: string }[];
    };
    // Newest first — first entry should be "improve"
    const last2 = versions2.versions[0];
    expect(last2.changeReason).toBe("improve");
  });

  // --- Fix A: version history stays consistent across successful saves ---
  it("keeps version-history length consistent with the artifact version across saves", async () => {
    // Create an artifact
    const createRes = await fetchApi("/plans", {
      method: "POST",
      body: JSON.stringify({
        domainId: "outing",
        goal: outingGoal,
        title: "Conflict test",
        normalizedInput: {
          departureAt: "2026-07-11T03:00:00Z",
          belongings: [{ id: "phone", name: "Phone", chargePercent: 20 }],
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      artifact: { id: string; version: number };
    };
    const planId = created.artifact.id;

    // Generate once to get version 2
    const genRes = await fetchApi(`/plans/${planId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(genRes.status).toBe(200);

    // Get version history length before conflict
    const versionsBefore = await fetchApi(`/plans/${planId}/versions`);
    expect(versionsBefore.status).toBe(200);
    const before = (await versionsBefore.json()) as { versions: unknown[] };
    const countBefore = before.versions.length;

    // Generate again (v3), which should succeed
    const gen2Res = await fetchApi(`/plans/${planId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(gen2Res.status).toBe(200);

    // Version history should now have one more entry
    const versionsAfter = await fetchApi(`/plans/${planId}/versions`);
    expect(versionsAfter.status).toBe(200);
    const after = (await versionsAfter.json()) as { versions: unknown[] };
    expect(after.versions.length).toBe(countBefore + 1);
  });
});
