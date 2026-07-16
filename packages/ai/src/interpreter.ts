import {
  clarificationQuestionSchema,
  interpretationAssumptionSchema,
  sourceReferenceSchema,
  type SourceInterpreter,
} from "@pear-agent/core";
import type { LanguageModel } from "ai";
import { z } from "zod";

import { generateStructured, type StructuredGenerator } from "./generate.js";

export type CreateAiSourceInterpreterOptions<TSchema extends z.ZodType> = {
  model: LanguageModel;
  normalizedInputSchema: TSchema;
  promptVersion?: string;
  schemaVersion?: string;
  generate?: StructuredGenerator;
  /** Set false for providers/models that cannot consume PDF file parts. */
  supportsPdf?: boolean;
};

export function createAiSourceInterpreter<TSchema extends z.ZodType>(
  options: CreateAiSourceInterpreterOptions<TSchema>,
): SourceInterpreter<z.output<TSchema>> {
  const resultSchema = z
    .object({
      kind: z.enum(["ready", "clarification_required"]),
      normalizedInput: options.normalizedInputSchema.nullable(),
      assumptions: z.array(
        z.object({
          summary: z.string().min(1).max(1_000),
          sourceRefs: z.array(sourceReferenceSchema).max(100).default([]),
        }),
      ),
      questions: z.array(
        z.object({
          question: z.string().min(1).max(2_000),
          reason: z.string().min(1).max(2_000),
          sourceRefs: z.array(sourceReferenceSchema).max(100).default([]),
        }),
      ),
    })
    .strict();
  const generate = options.generate ?? generateStructured;

  return {
    async interpret(input) {
      const pdfSources = input.sources.filter(
        ({ artifact, data }) => artifact.mediaType === "application/pdf" && data !== undefined,
      );
      if (pdfSources.length > 0 && options.supportsPdf === false) {
        throw new Error("Configured model does not support PDF source interpretation");
      }
      const sourceManifest = {
        compileInput: input.compileInput,
        sources: input.sources.map(({ artifact, extractedText }) => ({
          id: artifact.id,
          kind: artifact.kind,
          label: artifact.label,
          mediaType: artifact.mediaType,
          extractedText,
        })),
        clarificationAnswers: input.clarificationAnswers ?? {},
      };
      const result = await generate({
        model: options.model,
        schema: resultSchema,
        stage: "interpret",
        promptVersion: options.promptVersion ?? "pear-interpret-v1",
        schemaVersion: options.schemaVersion ?? `${input.domainId}@${input.domainVersion}`,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
        system: [
          "Interpret multiple source artifacts into one domain model.",
          "Use only supplied source ids in sourceRefs.",
          "Record minor assumptions. Return clarification_required only for material ambiguity.",
          "Never invent persistent ids; the Runtime assigns them.",
          input.instructions,
        ].join("\n"),
        prompt:
          pdfSources.length === 0
            ? JSON.stringify(sourceManifest)
            : [
                {
                  role: "user",
                  content: [
                    { type: "text", text: JSON.stringify(sourceManifest) },
                    ...pdfSources.map(({ artifact, data }) => ({
                      type: "file" as const,
                      data: data!,
                      mediaType: "application/pdf",
                      filename: artifact.label,
                    })),
                  ],
                },
              ],
      });

      const output = result.output as {
        kind: "ready" | "clarification_required";
        normalizedInput: z.output<TSchema> | null;
        assumptions: Array<{
          summary: string;
          sourceRefs: Array<z.output<typeof sourceReferenceSchema>>;
        }>;
        questions: Array<{
          question: string;
          reason: string;
          sourceRefs: Array<z.output<typeof sourceReferenceSchema>>;
        }>;
      };
      const assumptions = output.assumptions.map((assumption) =>
        interpretationAssumptionSchema.parse({ ...assumption, id: crypto.randomUUID() }),
      );
      if (output.kind === "clarification_required") {
        const questions = output.questions.map((question) =>
          clarificationQuestionSchema.parse({ ...question, id: crypto.randomUUID() }),
        );
        if (questions.length === 0) throw new Error("Clarification output contained no questions");
        return {
          kind: "clarification_required",
          questions,
          assumptions,
          generation: result.metadata,
        };
      }
      if (output.normalizedInput === null) {
        throw new Error("Ready interpretation contained no normalized input");
      }
      return {
        kind: "ready",
        normalizedInput: options.normalizedInputSchema.parse(output.normalizedInput),
        assumptions,
        generation: result.metadata,
      };
    },
  };
}
