import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { outingGoal } from "../../../../examples/outing-domain/src/domain.js";
import { contextHeaders } from "../test/integration-helpers.js";

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

async function createDraft(): Promise<string> {
  const response = await fetchApi("/plans", {
    method: "POST",
    body: JSON.stringify({ domainId: "outing", goal: outingGoal }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { artifact: { id: string } }).artifact.id;
}

async function getArtifact(planId: string) {
  const response = await fetchApi(`/plans/${planId}`);
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      artifact: { version: number; normalizedInput?: unknown; currentPlan: { steps: unknown[] } };
    }
  ).artifact;
}

describe("atomic plan build", () => {
  it("normalizes and generates in one request", async () => {
    const planId = await createDraft();
    const response = await fetchApi(`/plans/${planId}/build`, {
      method: "POST",
      body: JSON.stringify({
        input: {
          departureAt: "2026-07-14T03:00:00Z",
          belongings: [{ id: "phone", name: "Phone", chargePercent: 20 }],
          tasks: [],
        },
      }),
    });
    expect(response.status).toBe(200);
    const artifact = (
      (await response.json()) as { artifact: Awaited<ReturnType<typeof getArtifact>> }
    ).artifact;
    expect(artifact.version).toBe(2);
    expect(artifact.normalizedInput).toMatchObject({ departureAt: "2026-07-14T03:00:00Z" });
    expect(artifact.currentPlan.steps.length).toBeGreaterThan(0);
  });

  it("leaves the artifact unchanged when free text cannot be resolved", async () => {
    const planId = await createDraft();
    const response = await fetchApi(`/plans/${planId}/build`, {
      method: "POST",
      body: JSON.stringify({
        input: {
          departureAt: { freeText: "not a recognizable date" },
          belongings: [],
          tasks: [{ id: "pack", title: "Pack" }],
        },
      }),
    });
    expect(response.status).toBe(500);
    const artifact = await getArtifact(planId);
    expect(artifact.version).toBe(1);
    expect(artifact.normalizedInput).toBeUndefined();
    expect(artifact.currentPlan.steps).toEqual([]);
  });

  it("does not persist normalized input when generation fails", async () => {
    const planId = await createDraft();
    const response = await fetchApi(`/plans/${planId}/build`, {
      method: "POST",
      body: JSON.stringify({
        input: {
          departureAt: "2026-07-14T03:00:00Z",
          belongings: [],
          tasks: [{ id: "pack", title: "Pack" }],
          destinationLabel: "__generator_error__",
        },
      }),
    });
    expect(response.status).toBe(500);
    const artifact = await getArtifact(planId);
    expect(artifact.version).toBe(1);
    expect(artifact.normalizedInput).toBeUndefined();
    expect(artifact.currentPlan.steps).toEqual([]);
  });
});
