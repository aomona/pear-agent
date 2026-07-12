import type { PlanGenerator } from "@pear-agent/cloudflare";
import {
  buildOutingPlan,
  outingDomain,
  type OutingNormalizedInput,
} from "@pear-agent/outing-domain-example";
import { executionPlanSchema } from "@pear-agent/core";
import { z } from "zod";

import { refinePlanOrderWithGemini } from "./plan-order-refiner.js";

export type CreateOutingPlanGeneratorOptions = {
  getApiKey: () => string | undefined;
  /** When false, skip LLM ordering (tests). Default true. */
  refineOrder?: boolean;
};

/**
 * Outing PlanGenerator:
 * 1) Deterministic steps from Domain (`buildOutingPlan`)
 * 2) Optional Gemini pass to set `after` dependencies (order / parallelism)
 *
 * Always sets `plan.metadata.orderRefined` / `orderRefineReason` when refine is enabled
 * so UI can show whether ordering actually ran.
 */
export function createOutingPlanGenerator(
  options: CreateOutingPlanGeneratorOptions,
): PlanGenerator {
  const refineOrder = options.refineOrder !== false;

  return {
    async generatePlan({ domainId, goal, normalizedInput }) {
      if (domainId !== outingDomain.id) {
        throw new Error(`Unknown domain: ${domainId}`);
      }
      const parsed = outingDomain.schemas.normalizedInput.parse(
        normalizedInput,
      ) as OutingNormalizedInput;
      const base = buildOutingPlan(parsed);
      if (base.goal.id !== goal.id) {
        throw new Error("Planner goal id must match the requested goal id");
      }

      if (!refineOrder) {
        return executionPlanSchema(z.unknown()).parse({
          ...base,
          metadata: {
            ...base.metadata,
            orderRefined: false,
            orderRefineReason: "disabled",
          },
        });
      }

      const contextSummary = JSON.stringify({
        departureAt: parsed.departureAt,
        origin: parsed.originLabel,
        destination: parsed.destinationLabel,
        belongings: parsed.belongings.map((b) => ({
          id: b.id,
          charge: b.chargePercent,
        })),
        tasks: parsed.tasks.map((t) => ({ id: t.id, title: t.title })),
      });

      const { plan } = await refinePlanOrderWithGemini({
        apiKey: options.getApiKey(),
        plan: base,
        contextSummary,
      });
      return plan;
    },
  };
}

/** Deterministic-only generator (no Gemini). Useful for offline / tests. */
export const planGenerator: PlanGenerator = createOutingPlanGenerator({
  getApiKey: () => undefined,
  refineOrder: false,
});
