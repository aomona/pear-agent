import {
  generationMetadataSchema,
  sourceArtifactSchema,
  type GenerationStage,
} from "@pear-agent/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAiPlanGenerator,
  createAiSourceInterpreter,
  type StructuredGenerator,
} from "./index.js";

function fixtureGenerate(output: unknown): StructuredGenerator {
  return async (request) => ({
    output: request.schema.parse(output),
    metadata: generationMetadataSchema.parse({
      id: "generation-1",
      stage: request.stage as GenerationStage,
      provider: "fixture",
      model: "fixture-model",
      promptVersion: request.promptVersion,
      schemaVersion: request.schemaVersion,
      attempt: 1,
      warnings: [],
      createdAt: new Date(),
    }),
  });
}

const source = sourceArtifactSchema.parse({
  id: "source-1",
  planArtifactId: "artifact-1",
  kind: "text",
  status: "ready",
  label: "Task",
  mediaType: "text/plain",
  byteSize: 4,
  checksumSha256: "abc",
  createdByActorId: "actor-1",
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("@pear-agent/ai", () => {
  it("returns a typed interpretation with Runtime-owned assumption ids", async () => {
    const interpreter = createAiSourceInterpreter({
      model: {} as never,
      normalizedInputSchema: z.object({ title: z.string() }),
      generate: fixtureGenerate({
        kind: "ready",
        normalizedInput: { title: "Dinner" },
        assumptions: [{ summary: "Default serving size", sourceRefs: [{ sourceId: "source-1" }] }],
        questions: [],
      }),
    });
    const result = await interpreter.interpret({
      domainId: "cook",
      domainVersion: 1,
      compileInput: {},
      sources: [{ artifact: source, extractedText: "Cook dinner" }],
      instructions: "Interpret recipe",
    });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.normalizedInput).toEqual({ title: "Dinner" });
      expect(result.assumptions[0]?.id).toBeTruthy();
    }
  });

  it("passes PDF bytes as an AI SDK file part", async () => {
    let prompt: unknown;
    const generate: StructuredGenerator = async (request) => {
      prompt = request.prompt;
      return fixtureGenerate({
        kind: "ready",
        normalizedInput: { title: "Deck" },
        assumptions: [],
        questions: [],
      })(request);
    };
    const interpreter = createAiSourceInterpreter({
      model: {} as never,
      normalizedInputSchema: z.object({ title: z.string() }),
      generate,
    });
    await interpreter.interpret({
      domainId: "presentation",
      domainVersion: 1,
      compileInput: {},
      sources: [
        {
          artifact: sourceArtifactSchema.parse({
            ...source,
            mediaType: "application/pdf",
            label: "slides.pdf",
          }),
          data: new Uint8Array([37, 80, 68, 70]),
        },
      ],
      instructions: "Read slides",
    });
    expect(prompt).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "file", mediaType: "application/pdf" }),
        ]),
      }),
    ]);
  });

  it("replaces model plan and step ids while preserving dependencies", async () => {
    let next = 0;
    const generator = createAiPlanGenerator({
      model: {} as never,
      stepDataSchema: z.object({ kind: z.string() }),
      createId: () => String(++next),
      generate: fixtureGenerate({
        id: "temporary-plan",
        version: 99,
        goal: {
          id: "goal-1",
          description: "Dinner",
          successCriteria: [
            { id: "done", description: "Done", evaluator: { type: "human_confirmation" } },
          ],
          completionPolicy: "automatic",
        },
        steps: [
          {
            id: "a",
            executor: { type: "human" },
            after: [],
            requirements: [],
            estimatedDurationSeconds: 60,
            timers: [],
            domainData: { kind: "prep" },
            sourceRefs: [{ sourceId: "source-1" }],
          },
          {
            id: "b",
            executor: { type: "human" },
            after: ["a"],
            requirements: [],
            estimatedDurationSeconds: 60,
            timers: [],
            domainData: { kind: "cook" },
            sourceRefs: [{ sourceId: "source-1" }],
          },
        ],
      }),
    });
    const result = await generator.generatePlan({
      domainId: "cook",
      domainVersion: 1,
      goal: {
        id: "goal-1",
        description: "Dinner",
        successCriteria: [
          { id: "done", description: "Done", evaluator: { type: "human_confirmation" } },
        ],
        completionPolicy: "automatic",
      },
      normalizedInput: {},
      sourceRefs: [{ sourceId: "source-1" }],
      instructions: "Plan dinner",
      objectives: ["Finish together"],
    });
    expect(result.plan.id).toBe("plan-1");
    expect(result.plan.steps.map(({ id }) => id)).toEqual(["step-2", "step-3"]);
    expect(result.plan.steps[1]?.after).toEqual(["step-2"]);
  });
});
