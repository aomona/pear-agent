import type {
  AssessInput,
  ExecutionPlan,
  PlanPatch,
  ReplanCapabilityPolicy,
  ReplanAssessment,
  ReplanMode,
  StepStates,
  WorldState,
} from "@pear-agent/core";
import { replanCapabilityPolicySchema, replanModeSchema } from "@pear-agent/core";
import { z } from "zod";

import type { PearRequestContext } from "../context.js";

export type ReplanConfiguration = {
  /** Domain-declared instructions passed to the host AI SDK implementation. */
  instructions: string;
  domainVersion: number;
  defaultMode: ReplanMode;
  stepDataSchema: z.ZodType;
  capabilityPolicies: readonly ReplanCapabilityPolicy[];
  /** Required Domain policy: validate and recalculate resource utilization. */
  reconcileWorldState: (plan: ExecutionPlan, worldState: WorldState) => WorldState;
};

export type ReplanAssessInput = AssessInput & {
  sessionId: string;
  domainId: string;
  instructions: string;
  context: PearRequestContext;
  normalizedInput: unknown;
  /** Current step FSM — needed so Domain assess can skip completed work. */
  stepStates: StepStates;
};

export type ReplanGeneratePatchInput = ReplanAssessInput & {
  assessment: ReplanAssessment;
  affectedStepIds: string[];
  mode: ReplanMode;
};

/** Host port normally implemented with AI SDK structured generation. */
export type ReplanGenerator = {
  assess(input: ReplanAssessInput): Promise<ReplanAssessment>;
  generatePatch(input: ReplanGeneratePatchInput): Promise<PlanPatch>;
};

export type ReplanRuntime = {
  generator: ReplanGenerator;
  resolveConfiguration(domainId: string): ReplanConfiguration | Promise<ReplanConfiguration>;
};

export function validateReplanConfiguration(
  configuration: ReplanConfiguration,
): ReplanConfiguration {
  if (configuration.instructions.trim().length === 0) {
    throw new Error("Replan instructions must not be empty");
  }
  if (!Number.isInteger(configuration.domainVersion) || configuration.domainVersion < 1) {
    throw new Error("Replan Domain version must be a positive integer");
  }
  if (!(configuration.stepDataSchema instanceof z.ZodType)) {
    throw new Error("Replan stepDataSchema must be a Zod schema");
  }
  if (typeof configuration.reconcileWorldState !== "function") {
    throw new Error("Replan reconcileWorldState policy is required");
  }
  const capabilityPolicies = configuration.capabilityPolicies.map((policy) =>
    replanCapabilityPolicySchema.parse(policy),
  );
  if (new Set(capabilityPolicies.map(({ id }) => id)).size !== capabilityPolicies.length) {
    throw new Error("Replan capability policy IDs must be unique");
  }
  return {
    ...configuration,
    defaultMode: replanModeSchema.parse(configuration.defaultMode),
    capabilityPolicies,
  };
}

export function createStaticReplanGenerator(input: {
  assessment: ReplanAssessment | ((input: ReplanAssessInput) => ReplanAssessment);
  patch: PlanPatch | ((input: ReplanGeneratePatchInput) => PlanPatch);
}): ReplanGenerator {
  return {
    async assess(assessInput) {
      return typeof input.assessment === "function"
        ? input.assessment(assessInput)
        : input.assessment;
    },
    async generatePatch(patchInput) {
      return typeof input.patch === "function" ? input.patch(patchInput) : input.patch;
    },
  };
}
