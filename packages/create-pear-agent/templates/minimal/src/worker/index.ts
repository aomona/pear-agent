import {
  AuthorizationError,
  ExecutionSessionAgent,
  allowAllAuthorize,
  createPearWorker,
  type AuthorizeFn,
  type PearEnv,
} from "@pear-agent/cloudflare";
import { executionGoalSchema } from "@pear-agent/core";

import { starterDomain, starterNormalizedInputSchema } from "../domain/domain.js";
import { buildStarterPlan } from "../domain/plan.js";

export { ExecutionSessionAgent };

type StarterEnv = PearEnv & {
  PEAR_INSECURE_ALLOW_ALL?: string;
};

const denyAllAuthorize: AuthorizeFn = () => {
  throw new AuthorizationError(
    "Authorization is not configured. Replace denyAllAuthorize before deploying.",
  );
};

function createStarterWorker(authorize: AuthorizeFn) {
  return createPearWorker({
    authorize,
    planGenerator: {
      async generatePlan(input) {
        return buildStarterPlan(
          executionGoalSchema.parse(input.goal),
          starterNormalizedInputSchema.parse(input.normalizedInput),
        );
      },
    },
    planLibrary: {
      async normalizeDomainInput({ domainId, input }) {
        if (domainId !== starterDomain.id) {
          throw new Error(`Unknown domain: ${domainId}`);
        }
        return starterDomain.normalizeInput(starterDomain.schemas.input.parse(input));
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
