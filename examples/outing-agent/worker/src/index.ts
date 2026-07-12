import {
  createPearWorker,
  ExecutionSessionAgent,
  PEAR_CONTEXT_HEADER,
  resolvePearContextFromHeader,
} from "@pear-agent/cloudflare";
import { resolveMaybeFreeTextField } from "@pear-agent/core";
import {
  isOutingFreeTextField,
  outingDomain,
  outingFreeTextHints,
  outingFreeTextParse,
} from "@pear-agent/outing-domain-example";

import { authorize } from "./authorize.js";
import { handleCorsPreflight, withCors } from "./cors.js";
import { createGeminiFreeTextResolver } from "./free-text-resolver.js";
import { createOutingPlanGenerator, planGenerator } from "./plan-generator.js";
import { createGeminiPlanImprover } from "./plan-improver.js";
import { replanRuntime } from "./replan-runtime.js";

export { ExecutionSessionAgent };

const DEMO_CONTEXT = {
  actorId: "demo-user",
  roles: ["owner"] as string[],
  claims: {} as Record<string, unknown>,
};

const worker = createPearWorker({
  authorize,
  // Fallback without env (tests); production uses createPlanGenerator for Gemini ordering.
  planGenerator,
  createPlanGenerator: (env) =>
    createOutingPlanGenerator({
      getApiKey: () => env.GEMINI_API_KEY,
      refineOrder: true,
    }),
  replanRuntime,
  planLibrary: {
    normalizeDomainInput: async ({ domainId, input, freeTextResolver, context }) => {
      if (domainId !== outingDomain.id) {
        throw new Error(`Unknown domain: ${domainId}`);
      }
      const parsed = outingDomain.schemas.input.parse(input);
      return outingDomain.normalizeInput(parsed, {
        ...(freeTextResolver !== undefined ? { freeTextResolver } : {}),
        context,
      });
    },
    /** Single-field structure — always Gemini via Domain free-text registry. */
    resolveDomainFreeTextField: async ({
      domainId,
      field,
      freeText,
      freeTextResolver,
      context,
    }) => {
      if (domainId !== outingDomain.id) {
        throw new Error(`Unknown domain: ${domainId}`);
      }
      if (!freeTextResolver) {
        throw Object.assign(
          new Error(
            "GEMINI_API_KEY is not configured (required for free-text structure via Gemini)",
          ),
          { status: 503 as const },
        );
      }
      if (!isOutingFreeTextField(field)) {
        throw new Error(`Unsupported free-text field: ${field}`);
      }
      return resolveMaybeFreeTextField({
        domainId,
        field,
        value: { freeText },
        freeTextResolver,
        parse: (value: unknown) => outingFreeTextParse[field](value),
        hint: outingFreeTextHints[field],
        context,
      });
    },
    createFreeTextResolver: (env) =>
      createGeminiFreeTextResolver({
        getApiKey: () => env.GEMINI_API_KEY,
      }),
    createPlanImprover: (env) =>
      createGeminiPlanImprover({
        getApiKey: () => env.GEMINI_API_KEY,
      }),
  },
  resolveContext: async (request) => {
    if (!request.headers.get(PEAR_CONTEXT_HEADER)) {
      return DEMO_CONTEXT;
    }
    return resolvePearContextFromHeader(request);
  },
});

export default {
  async fetch(request: Request, env: Parameters<typeof worker.fetch>[1], ctx: ExecutionContext) {
    const preflight = handleCorsPreflight(request);
    if (preflight) return preflight;

    const response = await worker.fetch(request, env, ctx);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return response;
    }
    return withCors(request, response);
  },
};
