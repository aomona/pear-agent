import type { ReplanRuntime } from "@pear-agent/cloudflare";
import type { LanguageModel } from "ai";
import { outingDomain, reconcileOutingWorldState } from "@pear-agent/outing-domain-example";

import { createAiSdkReplanGenerator } from "./ai-sdk-replan-generator.js";

export function createOutingReplanRuntime(model: LanguageModel): ReplanRuntime {
  return {
    generator: createAiSdkReplanGenerator({ model }),
    resolveConfiguration: async (domainId) => {
      if (domainId !== outingDomain.id) {
        throw new Error(`Unknown domain for replan: ${domainId}`);
      }
      return {
        instructions: outingDomain.replanning.instructions,
        domainVersion: outingDomain.version,
        defaultMode: outingDomain.replanning.defaultMode,
        capabilityPolicies: outingDomain.capabilities.map(({ id, executionMode, riskLevel }) => ({
          id,
          executionMode,
          riskLevel,
        })),
        stepDataSchema: outingDomain.schemas.stepData,
        reconcileWorldState: reconcileOutingWorldState,
      };
    },
  };
}
