import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compileJobSchema,
  defineAiDomain,
  planChangeCauseRefSchema,
  resolvePlanPatchCauseRefs,
  sourceArtifactSchema,
} from "./index.js";

describe("AI-native compiler contracts", () => {
  it("parses durable source and compile records", () => {
    const source = sourceArtifactSchema.parse({
      id: "source-1",
      planArtifactId: "plan-1",
      kind: "url",
      status: "ready",
      label: "Recipe",
      mediaType: "text/html",
      byteSize: 42,
      checksumSha256: "abc",
      sourceUrl: "https://example.com/recipe",
      createdByActorId: "actor-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(source.rawObjectKey).toBeNull();

    expect(
      compileJobSchema.parse({
        id: "job-1",
        planArtifactId: "plan-1",
        phase: "interpret",
        status: "running",
        attempt: 1,
        modelCalls: 1,
        totalTokens: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).workflowInstanceId,
    ).toBeNull();
  });

  it("normalizes legacy runtime event causes into typed cause refs", () => {
    const patch = {
      id: "patch-1",
      basePlanId: "plan-1",
      basePlanVersion: 1,
      baseLastEventId: "event-1",
      causeEventIds: ["event-1"],
      affectedStepIds: ["step-1"],
      operations: [{ type: "remove_step" as const, stepId: "step-1" }],
      summary: "Remove affected step",
    };
    expect(resolvePlanPatchCauseRefs(patch)).toEqual([
      { type: "runtime_event", eventId: "event-1" },
    ]);
    expect(planChangeCauseRefSchema.parse({ type: "source", sourceId: "source-1" })).toEqual({
      type: "source",
      sourceId: "source-1",
    });
  });

  it("requires AI-native domain instructions and deterministic validation", () => {
    const domain = defineAiDomain({
      id: "presentation",
      version: 1,
      schemas: {
        compileInput: z.object({ durationSeconds: z.number().positive() }),
        normalizedInput: z.object({ slides: z.array(z.string()) }),
        stepData: z.object({ slide: z.number().int().positive() }),
        worldState: z.object({ currentSlide: z.number().int().positive() }),
        events: z.object({ type: z.literal("overrun") }),
      },
      interpretation: { instructions: "Read the PDF" },
      planning: {
        instructions: "Allocate slide time",
        objectives: ["Fit the duration"],
        validatePlan: () => ({ valid: true, issues: [] }),
      },
      replanning: {
        instructions: "Redistribute remaining time",
        defaultMode: "confirm",
        reconcileWorldState: (_plan, state) => state,
      },
      realtime: { instructions: "Track time", defaultLocale: "ja-JP" },
      capabilities: [],
      completionPolicy: "automatic",
    });
    expect(domain.replanning.defaultMode).toBe("confirm");
  });
});
