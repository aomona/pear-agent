import { createStaticReplanGenerator, type ReplanRuntime } from "@pear-agent/cloudflare";
import {
  assessOutingDelayReplan,
  buildOutingDelayPatch,
  outingDomain,
  reconcileOutingWorldState,
} from "@pear-agent/outing-domain-example";

export const replanRuntime: ReplanRuntime = {
  generator: createStaticReplanGenerator({
    assessment: (input) =>
      assessOutingDelayReplan({
        recentEvents: input.recentEvents.map((event) => ({
          id: event.id,
          type: event.type,
          ...(event.type === "domain_event"
            ? { domainType: event.domainType, payload: event.payload }
            : {}),
        })),
      }),
    patch: (input) =>
      buildOutingDelayPatch({
        plan: input.plan,
        assessment: input.assessment,
        affectedStepIds: input.affectedStepIds,
        recentEvents: input.recentEvents.map((event) => ({
          id: event.id,
          type: event.type,
          ...(event.type === "domain_event"
            ? { domainType: event.domainType, payload: event.payload }
            : {}),
        })),
        patchId: `patch-${crypto.randomUUID()}`,
      }),
  }),
  resolveConfiguration: async (domainId) => {
    if (domainId !== outingDomain.id && domainId !== "outing") {
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
