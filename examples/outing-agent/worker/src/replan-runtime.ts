import { createStaticReplanGenerator, type ReplanRuntime } from "@pear-agent/cloudflare";
import type { RuntimeEvent } from "@pear-agent/core";
import {
  assessOutingDelayReplan,
  buildOutingDelayPatch,
  outingDomain,
  reconcileOutingWorldState,
  type OutingReplanEventLike,
} from "@pear-agent/outing-domain-example";

function toOutingReplanEvents(events: readonly RuntimeEvent[]): OutingReplanEventLike[] {
  return events.map((event) => {
    if (event.type === "domain_event") {
      return {
        id: event.id,
        type: event.type,
        domainType: event.domainType,
        payload: event.payload,
      };
    }
    return { id: event.id, type: event.type };
  });
}

export const replanRuntime: ReplanRuntime = {
  generator: createStaticReplanGenerator({
    assessment: (input) =>
      assessOutingDelayReplan({
        recentEvents: toOutingReplanEvents(input.recentEvents),
      }),
    patch: (input) =>
      buildOutingDelayPatch({
        plan: input.plan,
        assessment: input.assessment,
        affectedStepIds: input.affectedStepIds,
        recentEvents: toOutingReplanEvents(input.recentEvents),
        patchId: `patch-${crypto.randomUUID()}`,
      }),
  }),
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
