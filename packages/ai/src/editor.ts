import { executionPlanSchema, type PlanEditor, type PlanImprover } from "@pear-agent/core";
import type { LanguageModel } from "ai";
import { z } from "zod";

import { generateStructured, type StructuredGenerator } from "./generate.js";

export type CreateAiPlanEditorOptions = {
  model: LanguageModel;
  stepDataSchema: z.ZodType;
  instructions: string;
  promptVersion?: string;
  generate?: StructuredGenerator;
};

export function createAiPlanEditor(options: CreateAiPlanEditorOptions): PlanEditor {
  const improve = createImprove(options);
  return { edit: improve };
}

/** AI SDK adapter for the Cloudflare plan-library improvement port. */
export function createAiPlanImprover(options: CreateAiPlanEditorOptions): PlanImprover {
  const improve = createImprove(options);
  return { improve };
}

function createImprove(options: CreateAiPlanEditorOptions) {
  const schema = executionPlanSchema(options.stepDataSchema);
  const generate = options.generate ?? generateStructured;
  return async (input: Parameters<PlanImprover["improve"]>[0]) => {
    const result = await generate({
      model: options.model,
      schema,
      stage: "edit",
      promptVersion: options.promptVersion ?? "pear-edit-v1",
      schemaVersion: input.domainId,
      system: [
        "Revise a draft execution plan according to the user's instruction.",
        "Preserve plan and step ids for unchanged work and increment the plan version exactly once.",
        "Keep sourceRefs and return a valid DAG. Do not apply the result; Runtime presents a diff.",
        options.instructions,
      ].join("\n"),
      prompt: JSON.stringify(input),
    });
    const candidate = schema.parse(result.output);
    return {
      kind: "full" as const,
      plan: schema.parse({
        ...candidate,
        id: input.basePlan.id,
        version: input.basePlan.version + 1,
      }),
    };
  };
}
