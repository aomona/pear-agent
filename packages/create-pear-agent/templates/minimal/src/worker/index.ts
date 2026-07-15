import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  DEFAULT_GEMINI_TEXT_MODEL,
  createAiPlanCompiler,
  createAiPlanGenerator,
  createAiSourceInterpreter,
} from "@pear-agent/ai";
import {
  AuthorizationError,
  ExecutionSessionAgent,
  allowAllAuthorize,
  createPearWorker,
  type AuthorizeFn,
  type PearEnv,
} from "@pear-agent/cloudflare";
import { executionGoalSchema, executionPlanSchema } from "@pear-agent/core";

import { starterDomain, starterNormalizedInputSchema } from "../domain/domain.js";
import { buildStarterPlan } from "../domain/plan.js";

export { ExecutionSessionAgent };

type StarterEnv = PearEnv & { PEAR_INSECURE_ALLOW_ALL?: string };

const denyAllAuthorize: AuthorizeFn = () => {
  throw new AuthorizationError(
    "Authorization is not configured. Replace denyAllAuthorize before deploying.",
  );
};

function createStarterWorker(authorize: AuthorizeFn) {
  return createPearWorker({
    authorize,
    // Explicit deterministic adapter for tests and direct legacy session creation.
    planGenerator: {
      async generatePlan(input) {
        return buildStarterPlan(
          executionGoalSchema.parse(input.goal),
          starterNormalizedInputSchema.parse(input.normalizedInput),
        );
      },
    },
    planLibrary: {
      createCompileRuntime(env) {
        if (!env.GEMINI_API_KEY) return undefined;
        const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });
        const model = google(DEFAULT_GEMINI_TEXT_MODEL);
        return createAiPlanCompiler({
          domainVersion: starterDomain.version,
          interpretationInstructions: starterDomain.interpretation.instructions,
          planningInstructions: starterDomain.planning.instructions,
          planningObjectives: starterDomain.planning.objectives,
          interpreter: createAiSourceInterpreter({
            model,
            normalizedInputSchema: starterDomain.schemas.normalizedInput,
          }),
          planner: createAiPlanGenerator({ model, stepDataSchema: starterDomain.schemas.stepData }),
          validateNormalizedInput: (input) => starterDomain.schemas.normalizedInput.parse(input),
          async validatePlan({ plan, normalizedInput }) {
            const validation = await starterDomain.planning.validatePlan(
              executionPlanSchema(starterDomain.schemas.stepData).parse(plan),
              starterDomain.schemas.normalizedInput.parse(normalizedInput),
            );
            if (!validation.valid) throw new Error(validation.issues.join("; "));
          },
        });
      },
    },
  });
}

const lockedWorker = createStarterWorker(denyAllAuthorize);
const localDevelopmentWorker = createStarterWorker(allowAllAuthorize);

export default {
  fetch(request: Request, env: StarterEnv, context: ExecutionContext) {
    const worker = env.PEAR_INSECURE_ALLOW_ALL === "true" ? localDevelopmentWorker : lockedWorker;
    return worker.fetch(request, env, context);
  },
};
