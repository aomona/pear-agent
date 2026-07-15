import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { outingGoal } from "../../../../examples/outing-domain/src/domain.js";
import { contextHeaders } from "../test/integration-helpers.js";

async function api(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(
    new Request(`http://example.com${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...contextHeaders(init?.headers) },
    }),
  );
}

describe("AI-native plan compile", () => {
  it("persists sources, generation trace, interpretation, and a review draft", async () => {
    const created = await api("/plans", {
      method: "POST",
      body: JSON.stringify({ domainId: "outing", goal: outingGoal }),
    });
    const planId = ((await created.json()) as { artifact: { id: string } }).artifact.id;
    const source = await api(`/plans/${planId}/sources`, {
      method: "POST",
      body: JSON.stringify({ kind: "text", label: "Brief", content: "Leave on time" }),
    });
    expect(source.status).toBe(201);

    const compiled = await api(`/plans/${planId}/compile-jobs`, {
      method: "POST",
      body: JSON.stringify({ compileInput: { destination: "station" } }),
    });
    expect(compiled.status).toBe(201);
    const compiledBody = (await compiled.json()) as {
      job: { status: string; phase: string };
      artifact: { status: string; version: number };
    };
    expect(compiledBody.job).toMatchObject({ status: "completed", phase: "review" });
    expect(compiledBody.artifact).toMatchObject({ status: "draft", version: 2 });

    const inspected = await api(`/plans/${planId}/inspector`);
    const inspector = (await inspected.json()) as {
      inspector: {
        sources: unknown[];
        jobs: unknown[];
        interpretations: unknown[];
        generations: unknown[];
      };
    };
    expect(inspector.inspector.sources).toHaveLength(1);
    expect(inspector.inspector.jobs).toHaveLength(1);
    expect(inspector.inspector.interpretations).toHaveLength(1);
    expect(inspector.inspector.generations).toHaveLength(2);
  });

  it("durably waits for material clarification", async () => {
    const created = await api("/plans", {
      method: "POST",
      body: JSON.stringify({ domainId: "outing", goal: outingGoal }),
    });
    const planId = ((await created.json()) as { artifact: { id: string } }).artifact.id;
    await api(`/plans/${planId}/sources`, {
      method: "POST",
      body: JSON.stringify({ kind: "text", label: "Brief", content: "Go somewhere" }),
    });
    const response = await api(`/plans/${planId}/compile-jobs`, {
      method: "POST",
      body: JSON.stringify({ compileInput: { clarify: true } }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      job: { status: string };
      clarification: { id: string; status: string };
    };
    expect(body.job.status).toBe("waiting");
    expect(body.clarification.status).toBe("pending");
    const answered = await api(`/plans/${planId}/clarifications/${body.clarification.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answers: { answer: "09:00" } }),
    });
    expect(answered.status).toBe(200);
  });

  it("reviews a natural-language edit diff before applying it", async () => {
    const created = await api("/plans", {
      method: "POST",
      body: JSON.stringify({ domainId: "outing", goal: outingGoal }),
    });
    const planId = ((await created.json()) as { artifact: { id: string } }).artifact.id;
    await api(`/plans/${planId}/sources`, {
      method: "POST",
      body: JSON.stringify({ kind: "text", label: "Brief", content: "Leave on time" }),
    });
    await api(`/plans/${planId}/compile-jobs`, {
      method: "POST",
      body: JSON.stringify({ compileInput: {} }),
    });
    const proposed = await api(`/plans/${planId}/edit-proposals`, {
      method: "POST",
      body: JSON.stringify({ request: "Give the first step more time" }),
    });
    expect(proposed.status).toBe(201);
    const proposal = (await proposed.json()) as {
      proposal: { id: string; status: string; diff: { updatedStepIds: string[] } };
    };
    expect(proposal.proposal.status).toBe("pending");
    expect(proposal.proposal.diff.updatedStepIds).toHaveLength(1);

    const confirmed = await api(`/plans/${planId}/edit-proposals/${proposal.proposal.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as { artifact: { version: number } };
    expect(confirmedBody.artifact.version).toBe(3);
  });
});
