import {
  outingDomain,
  outingGoal,
  outingPlan,
} from "../../../examples/outing-domain/src/domain.js";
import { PlanPatchValidationError, createStaticPlanImprover } from "@pear-agent/core";

import { allowAllAuthorize, AuthorizationError, type AuthorizeFn } from "./authorize.js";
import { ExecutionSessionAgent } from "./agent/execution-session-agent.js";
import { createStaticPlanGenerator } from "./planner.js";
import { createStaticReplanGenerator } from "./replan/engine.js";
import { createPearWorker } from "./worker.js";

export { ExecutionSessionAgent };

/**
 * Test/demo Worker entry. Production hosts call {@link createPearWorker} (or
 * {@link createPearApp} + `routeAgentRequest`) with their own authorize + AI SDK
 * PlanGenerator and export ExecutionSessionAgent.
 */
const denyHeader = "x-pear-deny";

const authorize: AuthorizeFn = async (operation, context) => {
  if (context.claims["deny"] === true) {
    throw new AuthorizationError("Denied by test claim");
  }
  // Allow integration tests to force a deny via header-derived claim only.
  await allowAllAuthorize(operation, context);
};

const staticPlanGenerator = createStaticPlanGenerator(outingPlan);

const worker = createPearWorker({
  authorize,
  planGenerator: {
    async generatePlan(input) {
      if (
        typeof input.normalizedInput === "object" &&
        input.normalizedInput !== null &&
        "destinationLabel" in input.normalizedInput &&
        input.normalizedInput.destinationLabel === "__generator_error__"
      ) {
        throw new Error("Forced generator failure");
      }
      return staticPlanGenerator.generatePlan(input);
    },
  },
  planLibrary: {
    planImprover: createStaticPlanImprover((input) => ({
      ...input.basePlan,
      steps: input.basePlan.steps.map((step, index) =>
        index === 0
          ? {
              ...step,
              estimatedDurationSeconds: step.estimatedDurationSeconds + 30,
              ...(input.request === "remove provenance" ? { sourceRefs: [] } : {}),
            }
          : step,
      ),
    })),
    validatePlanEdit({ plan }) {
      if (plan.steps.some((step) => !step.sourceRefs?.length)) {
        throw new Error("Every edited step must preserve source provenance");
      }
    },
    createCompileRuntime: () => ({
      async compile(input) {
        if (
          typeof input.compileInput === "object" &&
          input.compileInput !== null &&
          "delayMs" in input.compileInput &&
          typeof input.compileInput.delayMs === "number"
        ) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, input.compileInput.delayMs);
            input.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(input.signal?.reason ?? new Error("Compile aborted"));
              },
              { once: true },
            );
          });
        }
        const now = new Date();
        const metadata = (stage: "interpret" | "plan") =>
          ({
            id: crypto.randomUUID(),
            stage,
            provider: "fixture",
            model: "fixture-model",
            promptVersion: "test-v1",
            schemaVersion: "outing@1",
            inputTokens: 10,
            outputTokens: 10,
            totalTokens: 20,
            attempt: 1,
            warnings: [],
            createdAt: now,
          }) as const;
        if (
          typeof input.compileInput === "object" &&
          input.compileInput !== null &&
          "clarify" in input.compileInput
        ) {
          return {
            kind: "clarification_required" as const,
            questions: [
              {
                id: crypto.randomUUID(),
                question: "When?",
                reason: "Timing changes the plan",
                sourceRefs: [{ sourceId: input.sources[0]!.artifact.id }],
              },
            ],
            assumptions: [],
            interpretationGeneration: metadata("interpret"),
          };
        }
        return {
          kind: "ready" as const,
          normalizedInput: { fixture: true },
          assumptions: [],
          plan: {
            ...outingPlan,
            steps: outingPlan.steps.map((step) => ({
              ...step,
              sourceRefs: [{ sourceId: input.sources[0]!.artifact.id }],
            })),
          },
          interpretationGeneration: metadata("interpret"),
          planGeneration: metadata("plan"),
        };
      },
    }),
    normalizeDomainInput: async ({ domainId, input, freeTextResolver, context }) => {
      if (domainId !== outingDomain.id) throw new Error(`Unknown domain: ${domainId}`);
      const parsed = outingDomain.schemas.input.parse(input);
      return outingDomain.normalizeInput(parsed, {
        ...(freeTextResolver !== undefined ? { freeTextResolver } : {}),
        context,
      });
    },
  },
  createReplanRuntime: () => ({
    generator: createStaticReplanGenerator({
      assessment: (input) => {
        if (input.instructions !== outingDomain.replanning.instructions) {
          throw new Error("Domain replanning instructions were not forwarded");
        }
        const cause = [...input.recentEvents]
          .reverse()
          .find((event) => event.type === "domain_event" && event.domainType === "delay");
        if (
          cause?.type === "domain_event" &&
          typeof cause.payload === "object" &&
          cause.payload !== null &&
          !Array.isArray(cause.payload) &&
          cause.payload["minutes"] === 999
        ) {
          throw new Error("provider request failed: api_key=do-not-persist");
        }
        return cause
          ? {
              needsReplan: true,
              causeEventIds: [cause.id],
              directlyAffectedStepIds: ["charge"],
              reason: "A delay changes the charging window",
            }
          : {
              needsReplan: false,
              causeEventIds: [],
              directlyAffectedStepIds: [],
              reason: "No delay event requires replanning",
            };
      },
      patch: (input) => {
        const charge = input.plan.steps.find(({ id }) => id === "charge");
        if (!charge) throw new Error("Test plan has no charge step");
        const cause = input.recentEvents.find(
          (event) => event.id === input.assessment.causeEventIds[0],
        );
        const missingResource =
          cause?.type === "domain_event" &&
          typeof cause.payload === "object" &&
          cause.payload !== null &&
          !Array.isArray(cause.payload) &&
          cause.payload["minutes"] === 777;
        return {
          id: `patch-${crypto.randomUUID()}`,
          basePlanId: input.plan.id,
          basePlanVersion: input.plan.version,
          baseLastEventId:
            input.recentEvents
              .filter(
                ({ type }) =>
                  type !== "replan_proposed" &&
                  type !== "replan_failed" &&
                  type !== "plan_updated" &&
                  !type.startsWith("continuation_"),
              )
              .at(-1)?.id ?? null,
          causeEventIds: input.assessment.causeEventIds,
          affectedStepIds: input.affectedStepIds,
          operations: [
            {
              type: "update_step",
              stepId: charge.id,
              step: {
                ...charge,
                estimatedDurationSeconds: charge.estimatedDurationSeconds + 60,
                requirements: missingResource ? ["battery"] : charge.requirements,
                // The Domain schema intentionally strips this generated field;
                // integration tests assert the normalized Patch is persisted.
                domainData: { ...charge.domainData, discardedByDomainSchema: "secret" },
              },
            },
          ],
          summary: "Extend charging by one minute after the delay",
        };
      },
    }),
    resolveConfiguration: (domainId) => ({
      instructions: outingDomain.replanning.instructions,
      domainVersion: outingDomain.version,
      defaultMode: domainId === "outing-confirm" ? "confirm" : outingDomain.replanning.defaultMode,
      capabilityPolicies: outingDomain.capabilities.map(({ id, executionMode, riskLevel }) => ({
        id,
        executionMode,
        riskLevel,
      })),
      stepDataSchema: outingDomain.schemas.stepData,
      reconcileWorldState: (plan, worldState) => {
        outingDomain.schemas.worldState.parse(worldState.facts);
        const availableResources = new Set(worldState.resources.map(({ id }) => id));
        for (const step of plan.steps) {
          const unavailable = step.requirements.find((id) => !availableResources.has(id));
          if (unavailable) {
            throw new PlanPatchValidationError(
              `Unavailable WorldState resource ${unavailable} for step ${step.id}`,
            );
          }
        }
        return {
          ...worldState,
          resources: [
            ...worldState.resources.filter(({ id }) => id !== "plan-utilization"),
            {
              id: "plan-utilization",
              state: {
                requirementsByStep: Object.fromEntries(
                  plan.steps.map((step) => [step.id, step.requirements]),
                ),
              },
            },
          ],
        };
      },
    }),
  }),
  // Integration tests mint tokens without calling Google.
  voiceTokenMinter: async (input) => ({
    token: `test-token-${input.lease.id}`,
    model: "test-model",
  }),
  resolveContext: (request) => {
    const raw = request.headers.get("x-pear-context");
    if (!raw) {
      return {
        actorId: "test-actor",
        roles: ["tester"],
        claims: request.headers.get(denyHeader) === "1" ? { deny: true } : {},
      };
    }
    const parsed = JSON.parse(raw) as {
      actorId: string;
      roles?: string[];
      claims?: Record<string, unknown>;
    };
    return {
      actorId: parsed.actorId,
      roles: parsed.roles ?? [],
      claims: {
        ...parsed.claims,
        ...(request.headers.get(denyHeader) === "1" ? { deny: true } : {}),
      },
    };
  },
});

// Keep goal import live for type-level coupling to the sample domain.
void outingGoal;

export default {
  fetch: worker.fetch,
};
