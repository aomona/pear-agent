import { describe, expect, it } from "vitest";
import { presentationDomain } from "./index.js";

describe("presentationDomain", () => {
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
});
