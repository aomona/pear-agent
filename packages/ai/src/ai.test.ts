import {
  generationMetadataSchema,
  sourceArtifactSchema,
  type GenerationStage,
} from "@pear-agent/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAiPlanGenerator,
  createAiPlanCompiler,
  createAiPlanEditor,
  createAiReplanGenerator,
  createAiSourceInterpreter,
  generateStructured,
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
  it("rejects an invalid retry bound before calling the provider", async () => {
    await expect(
      generateStructured({
        model: {} as never,
        schema: z.object({ ok: z.boolean() }),
        stage: "plan",
        promptVersion: "test",
        schemaVersion: "test",
        system: "test",
        prompt: "test",
        maxAttempts: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("maxAttempts must be an integer between 1 and 10");
  });

  it("rejects an impossible call budget before invoking a model phase", async () => {
    let interpreterCalled = false;
    const compiler = createAiPlanCompiler({
      domainVersion: 1,
      interpretationInstructions: "Interpret",
      planningInstructions: "Plan",
      planningObjectives: [],
      maxModelCalls: 1,
      interpreter: {
        async interpret() {
          interpreterCalled = true;
          throw new Error("must not run");
        },
      },
      planner: {
        async generatePlan() {
          throw new Error("must not run");
        },
      },
    });
    await expect(
      compiler.compile({
        artifact: {
          domainId: "cook",
          goal: {
            id: "goal-1",
            description: "Dinner",
            successCriteria: [
              { id: "done", description: "Done", evaluator: { type: "human_confirmation" } },
            ],
            completionPolicy: "automatic",
          },
        },
        sources: [{ artifact: source }],
        compileInput: {},
      }),
    ).rejects.toThrow("at least two model calls");
    expect(interpreterCalled).toBe(false);
  });

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

  it("rejects interpretation provenance from an unknown source", async () => {
    const interpreter = createAiSourceInterpreter({
      model: {} as never,
      normalizedInputSchema: z.object({ title: z.string() }),
      generate: fixtureGenerate({
        kind: "ready",
        normalizedInput: { title: "Dinner" },
        assumptions: [{ summary: "Invented", sourceRefs: [{ sourceId: "unknown" }] }],
        questions: [],
      }),
    });
    await expect(
      interpreter.interpret({
        domainId: "cook",
        domainVersion: 1,
        compileInput: {},
        sources: [{ artifact: source, extractedText: "Cook dinner" }],
        instructions: "Interpret recipe",
      }),
    ).rejects.toThrow("unknown source unknown");
  });

  it("overrides model-owned plan identity during editing", async () => {
    const basePlan = {
      id: "trusted-plan",
      version: 3,
      goal: {
        id: "goal-1",
        description: "Dinner",
        successCriteria: [
          { id: "done", description: "Done", evaluator: { type: "human_confirmation" as const } },
        ],
        completionPolicy: "automatic" as const,
      },
      steps: [],
    };
    const editor = createAiPlanEditor({
      model: {} as never,
      stepDataSchema: z.unknown(),
      instructions: "Edit",
      generate: fixtureGenerate({ ...basePlan, id: "model-plan", version: 99 }),
    });
    const result = await editor.edit({
      domainId: "cook",
      basePlan,
      goal: basePlan.goal,
      request: "Improve",
      normalizedInput: {},
      sourceRefs: [],
    });
    expect(result.plan).toMatchObject({ id: "trusted-plan", version: 4 });
  });

  it("builds replan identity and anchors only from Runtime input", async () => {
    const replanner = createAiReplanGenerator({
      model: {} as never,
      stepDataSchema: z.unknown(),
      createId: () => "1",
      generate: fixtureGenerate({
        operations: [{ type: "remove_step", stepId: "step-1" }],
        summary: "Remove blocked work",
      }),
    });
    const patch = await replanner.generatePatch({
      domainId: "cook",
      instructions: "Replan",
      plan: {
        id: "trusted-plan",
        version: 3,
        goal: {
          id: "goal-1",
          description: "Dinner",
          successCriteria: [],
          completionPolicy: "automatic",
        },
        steps: [],
      },
      normalizedInput: {},
      assessment: {},
      affectedStepIds: ["step-1"],
      causeRefs: [{ type: "runtime_event", eventId: "event-1" }],
      baseLastEventId: "event-1",
    });
    expect(patch).toMatchObject({
      id: "patch-1",
      basePlanId: "trusted-plan",
      basePlanVersion: 3,
      baseLastEventId: "event-1",
      causeEventIds: ["event-1"],
      affectedStepIds: ["step-1"],
    });
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

  it("rejects planner steps that omit or invent source provenance", async () => {
    const generator = createAiPlanGenerator({
      model: {} as never,
      stepDataSchema: z.object({ kind: z.string() }),
      generate: fixtureGenerate({
        id: "temporary-plan",
        version: 1,
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
            sourceRefs: [],
          },
        ],
      }),
    });
    await expect(
      generator.generatePlan({
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
      }),
    ).rejects.toThrow(/must cite at least one source/);
  });

  it("rewrites replan add_step ids and validates domain step data", async () => {
    const replanner = createAiReplanGenerator({
      model: {} as never,
      stepDataSchema: z.object({ kind: z.string() }),
      createId: () => "runtime",
      generate: fixtureGenerate({
        operations: [
          {
            type: "add_step",
            step: {
              id: "model-step",
              executor: { type: "human" },
              after: [],
              requirements: [],
              estimatedDurationSeconds: 30,
              timers: [],
              domainData: { kind: "prep" },
            },
          },
        ],
        summary: "Add prep",
      }),
    });
    const patch = await replanner.generatePatch({
      domainId: "cook",
      instructions: "Replan",
      plan: {
        id: "trusted-plan",
        version: 1,
        goal: {
          id: "goal-1",
          description: "Dinner",
          successCriteria: [],
          completionPolicy: "automatic",
        },
        steps: [],
      },
      normalizedInput: {},
      assessment: {},
      affectedStepIds: ["model-step"],
      causeRefs: [{ type: "runtime_event", eventId: "event-1" }],
      baseLastEventId: "event-1",
    });
    expect(patch.operations[0]).toMatchObject({
      type: "add_step",
      step: { id: "step-runtime" },
    });
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
