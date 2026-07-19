import {
  defineDomain,
  resolveMaybeFreeTextField,
  type NormalizeInputContext,
} from "@pear-agent/core";

import { outingFreeTextHints, outingFreeTextParse } from "./free-text-fields.js";
import {
  OUTING_DOMAIN_ID,
  OUTING_DOMAIN_VERSION,
  outingEventSchema,
  outingInputSchema,
  outingNormalizedInputSchema,
  outingStepDataSchema,
  outingWorldStateFactsSchema,
} from "./schemas.js";

export * from "./plan.js";
export * from "./replan.js";
export * from "./schemas.js";
export {
  isOutingFreeTextField,
  outingFreeTextGeminiSchemas,
  outingFreeTextHints,
  outingFreeTextParse,
  unwrapOutingFreeTextGeminiResult,
  OUTING_FREE_TEXT_FIELDS,
  type OutingFreeTextField,
} from "./free-text-fields.js";

async function resolveOptionalLabel(
  field: "originLabel" | "destinationLabel",
  value: string | { freeText: string } | undefined,
  fieldOptions: {
    domainId: string;
    freeTextResolver?: NormalizeInputContext["freeTextResolver"];
    context?: unknown;
  },
): Promise<string | null> {
  if (value === undefined) return null;
  if (typeof value === "string") return outingFreeTextParse[field](value);
  return resolveMaybeFreeTextField({
    ...fieldOptions,
    field,
    value,
    parse: outingFreeTextParse[field],
    hint: outingFreeTextHints[field],
  });
}

/** PEAR Domain contract; schemas, plan builders and replan policy live in focused modules. */
export const outingDomain = defineDomain({
  id: OUTING_DOMAIN_ID,
  version: OUTING_DOMAIN_VERSION,
  schemas: {
    input: outingInputSchema,
    normalizedInput: outingNormalizedInputSchema,
    stepData: outingStepDataSchema,
    worldState: outingWorldStateFactsSchema,
    events: outingEventSchema,
  },
  normalizeInput: async (input, context?: NormalizeInputContext) => {
    const fieldOptions = {
      domainId: OUTING_DOMAIN_ID,
      ...(context?.freeTextResolver !== undefined
        ? { freeTextResolver: context.freeTextResolver }
        : {}),
      ...(context?.context !== undefined ? { context: context.context } : {}),
    };
    const departureAt = await resolveMaybeFreeTextField({
      ...fieldOptions,
      field: "departureAt",
      value: input.departureAt,
      parse: outingFreeTextParse.departureAt,
      hint: outingFreeTextHints.departureAt,
    });
    const belongings = await resolveMaybeFreeTextField({
      ...fieldOptions,
      field: "belongings",
      value: input.belongings ?? [],
      parse: outingFreeTextParse.belongings,
      hint: outingFreeTextHints.belongings,
    });
    const tasks = await resolveMaybeFreeTextField({
      ...fieldOptions,
      field: "tasks",
      value: input.tasks ?? [],
      parse: outingFreeTextParse.tasks,
      hint: outingFreeTextHints.tasks,
    });
    const originLabel = await resolveOptionalLabel("originLabel", input.originLabel, fieldOptions);
    const destinationLabel = await resolveOptionalLabel(
      "destinationLabel",
      input.destinationLabel,
      fieldOptions,
    );
    return {
      departureAt,
      belongings: belongings.map((belonging) => ({
        ...belonging,
        chargePercent: belonging.chargePercent ?? null,
      })),
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        estimatedDurationSeconds: task.estimatedDurationSeconds ?? null,
        notes: task.notes ?? null,
      })),
      originLabel,
      destinationLabel,
    };
  },
  planning: {
    instructions:
      "出発時刻・行き先までに必要な持ち物・充電・準備タスクを整える。並行可能な準備は並列 step にする。",
    objectives: ["必要な持ち物を揃える", "必要な機器を充電する", "出発前の準備タスクを完了する"],
  },
  replanning: {
    instructions: "遅延の影響を受ける準備だけを更新する",
    defaultMode: "automatic",
  },
  capabilities: [],
  completionPolicy: "automatic",
});
