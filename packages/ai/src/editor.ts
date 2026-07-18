import {
  executionPlanSchema,
  type PlanEditor,
  type PlanEditorInput,
  type PlanImproveResult,
  type PlanImprover,
  type PlanImproveInput,
} from "@pear-agent/core";
import type { LanguageModel } from "ai";
import type { z } from "zod";

import { generateStructured, type StructuredGenerator } from "./generate.js";
import { rewriteEditedPlanIdentity } from "./identity.js";

export type CreateAiPlanEditorOptions = {
  model: LanguageModel;
  stepDataSchema: z.ZodType;
  instructions: string;
  promptVersion?: string;
  generate?: StructuredGenerator;
  createId?: () => string;
};

export function createAiPlanEditor(options: CreateAiPlanEditorOptions): PlanEditor {
  const edit = createEdit(options);
  return {
    edit(input) {
      return edit(input);
    },
  };
}

/** AI SDK adapter for the Cloudflare plan-library improvement port. */
export function createAiPlanImprover(options: CreateAiPlanEditorOptions): PlanImprover {
  const edit = createEdit(options);
  return {
    improve(input) {
      return edit({
        domainId: input.domainId,
        basePlan: input.basePlan,
        goal: input.goal,
        request: input.request,
        normalizedInput: input.normalizedInput ?? {},
        sourceRefs: [],
        ...(input.context !== undefined ? { context: input.context } : {}),
      });
    },
  };
}

function createEdit(options: CreateAiPlanEditorOptions) {
  const schema = executionPlanSchema(options.stepDataSchema);
  const generate = options.generate ?? generateStructured;
  const createId = options.createId ?? (() => crypto.randomUUID());
  return async (
    input: PlanEditorInput | (PlanImproveInput & { sourceRefs?: never }),
  ): Promise<PlanImproveResult> => {
    const editorInput: PlanEditorInput = {
      domainId: input.domainId,
      basePlan: input.basePlan,
      goal: input.goal,
      request: input.request,
      normalizedInput: input.normalizedInput ?? {},
      sourceRefs: "sourceRefs" in input && input.sourceRefs ? input.sourceRefs : [],
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...("signal" in input && input.signal ? { signal: input.signal } : {}),
      ...("maxAttempts" in input && input.maxAttempts !== undefined
        ? { maxAttempts: input.maxAttempts }
        : {}),
      ...("maxOutputTokens" in input && input.maxOutputTokens !== undefined
        ? { maxOutputTokens: input.maxOutputTokens }
        : {}),
    };
    const result = await generate({
      model: options.model,
      schema,
      stage: "edit",
      promptVersion: options.promptVersion ?? "pear-edit-v1",
      schemaVersion: editorInput.domainId,
      ...(editorInput.signal ? { signal: editorInput.signal } : {}),
      ...(editorInput.maxAttempts === undefined ? {} : { maxAttempts: editorInput.maxAttempts }),
      ...(editorInput.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: editorInput.maxOutputTokens }),
      system: [
        "Revise a draft execution plan according to the user's instruction.",
        "Preserve plan and step ids for unchanged work; Runtime rewrites only newly added step ids.",
        "Keep sourceRefs to known sources and return a valid DAG. Do not apply the result; Runtime presents a diff.",
        "Do not change the plan goal.",
        options.instructions,
      ].join("\n"),
      prompt: JSON.stringify({
        domainId: editorInput.domainId,
        basePlan: editorInput.basePlan,
        goal: editorInput.goal,
        request: editorInput.request,
        normalizedInput: editorInput.normalizedInput,
        availableSourceRefs: editorInput.sourceRefs,
      }),
    });
    const candidate = schema.parse(result.output);
    const plan = schema.parse(
      rewriteEditedPlanIdentity(
        candidate,
        {
          basePlan: editorInput.basePlan,
          goal: editorInput.goal,
          sourceRefs: editorInput.sourceRefs,
        },
        createId,
      ),
    );
    return { kind: "full" as const, plan };
  };
}
