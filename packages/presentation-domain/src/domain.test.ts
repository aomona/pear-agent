import { describe, expect, it } from "vitest";
import {
  presentationCompileInputSchema,
  presentationDomain,
  presentationNormalizedInputSchema,
} from "./index.js";

describe("presentationDomain", () => {
  it("requires a positive speaking budget in compile and normalized input", () => {
    expect(() =>
      presentationCompileInputSchema.parse({ totalSeconds: 60, bufferSeconds: 60 }),
    ).toThrow("bufferSeconds must be less than totalSeconds");
    expect(() =>
      presentationNormalizedInputSchema.parse({
        totalSeconds: 60,
        bufferSeconds: 61,
        slides: [{ page: 2, title: "Hi", role: "opening", keyPoints: ["hello"], sourceId: "pdf" }],
      }),
    ).toThrow("bufferSeconds must be less than totalSeconds");
  });

  it("rejects plans beyond the speaking budget", async () => {
    const result = await presentationDomain.planning.validatePlan(
      {
        id: "p",
        version: 1,
        goal: { id: "g", description: "Talk", successCriteria: [], completionPolicy: "automatic" },
        steps: [
          {
            id: "s",
            executor: { type: "human" },
            after: [],
            requirements: [],
            estimatedDurationSeconds: 100,
            timers: [],
            domainData: {
              kind: "slide",
              page: 1,
              role: "opening",
              keyPoints: ["hello"],
              transition: "next",
            },
          },
        ],
      },
      {
        totalSeconds: 90,
        bufferSeconds: 10,
        slides: [{ page: 1, title: "Hi", role: "opening", keyPoints: ["hello"], sourceId: "pdf" }],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain("exceeds");
  });

  it("preserves the page numbers supplied by normalized slide order", async () => {
    const result = await presentationDomain.planning.validatePlan(
      {
        id: "p",
        version: 1,
        goal: { id: "g", description: "Talk", successCriteria: [], completionPolicy: "automatic" },
        steps: [
          {
            id: "s",
            executor: { type: "human" },
            after: [],
            requirements: [],
            estimatedDurationSeconds: 30,
            timers: [],
            domainData: {
              kind: "slide",
              page: 2,
              role: "opening",
              keyPoints: ["hello"],
              transition: "next",
            },
            sourceRefs: [{ sourceId: "pdf" }],
          },
        ],
      },
      {
        totalSeconds: 90,
        bufferSeconds: 10,
        slides: [{ page: 2, title: "Hi", role: "opening", keyPoints: ["hello"], sourceId: "pdf" }],
      },
    );
    expect(result.valid).toBe(true);
  });
});
