import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  DEFAULT_GEMINI_TEXT_MODEL,
  createAiPlanImprover,
  createAiPlanCompiler,
  createAiPlanGenerator,
  createAiSourceInterpreter,
} from "@pear-agent/ai";
import {
  AuthorizationError,
  ExecutionSessionAgent,
  allowAllAuthorize,
  createPearWorker,
  D1CompileRepository,
  runPlanCompileJob,
  type AuthorizeFn,
  type PearEnv,
  type PlanCompileWorkflowParams,
} from "@pear-agent/cloudflare";
import { executionGoalSchema, executionPlanSchema } from "@pear-agent/core";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { starterDomain, starterNormalizedInputSchema } from "../domain/domain.js";
import { buildStarterPlan } from "../domain/plan.js";

export { ExecutionSessionAgent };

type StarterEnv = PearEnv & { PEAR_INSECURE_ALLOW_ALL?: string };

function createStarterCompileRuntime(env: StarterEnv) {
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
    validateCompileInput: (input) => starterDomain.schemas.compileInput.parse(input),
    validateNormalizedInput: (input) => starterDomain.schemas.normalizedInput.parse(input),
    async validatePlan({ plan, normalizedInput }) {
      const validation = await starterDomain.planning.validatePlan(
        executionPlanSchema(starterDomain.schemas.stepData).parse(plan),
        starterDomain.schemas.normalizedInput.parse(normalizedInput),
      );
      if (!validation.valid) throw new Error(validation.issues.join("; "));
    },
  });
}

export class PlanCompileWorkflow extends WorkflowEntrypoint<StarterEnv, PlanCompileWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<PlanCompileWorkflowParams>>, step: WorkflowStep) {
    try {
      return await step.do(
        "compile-plan",
        {
          retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
          timeout: "30 minutes",
        },
        async () => {
          const runtime = createStarterCompileRuntime(this.env);
          if (!runtime) throw new Error("GEMINI_API_KEY is not configured");
          const result = await runPlanCompileJob({
            env: this.env,
            params: event.payload,
            runtime,
            durableRetry: true,
          });
          return { jobId: result.job.id, status: result.job.status };
        },
      );
    } catch (error) {
      const repository = new D1CompileRepository(this.env.DB);
      const job = await repository.getJob(event.payload.jobId);
      if (job && ["queued", "running", "waiting"].includes(job.status)) {
        await repository.updateJob(job.id, {
          status: "failed",
          error: error instanceof Error ? error.message.slice(0, 4_000) : "Compile failed",
        });
      }
      throw error;
    }
  }
}

const denyAllAuthorize: AuthorizeFn = () => {
  throw new AuthorizationError(
    "Authorization is not configured. Replace denyAllAuthorize before deploying.",
  );
};

function createStarterWorker(authorize: AuthorizeFn) {
  return createPearWorker({
    authorize,
    realtimeInstructions: starterDomain.realtime.instructions,
    realtimeLocale: starterDomain.realtime.defaultLocale,
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
      createPlanImprover(env) {
        if (!env.GEMINI_API_KEY) return undefined;
        const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });
        return createAiPlanImprover({
          model: google(DEFAULT_GEMINI_TEXT_MODEL),
          stepDataSchema: starterDomain.schemas.stepData,
          instructions: starterDomain.planning.instructions,
        });
      },
      async validatePlanEdit({ plan, normalizedInput }) {
        const validation = await starterDomain.planning.validatePlan(
          executionPlanSchema(starterDomain.schemas.stepData).parse(plan),
          starterDomain.schemas.normalizedInput.parse(normalizedInput),
        );
        if (!validation.valid) throw new Error(validation.issues.join("; "));
      },
      createCompileRuntime(env) {
        return createStarterCompileRuntime(env);
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
