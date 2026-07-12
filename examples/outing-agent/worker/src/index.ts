import {
  createPearWorker,
  ExecutionSessionAgent,
  PEAR_CONTEXT_HEADER,
  resolvePearContextFromHeader,
} from "@pear-agent/cloudflare";
import { resolveMaybeFreeTextField } from "@pear-agent/core";
import { outingDomain } from "@pear-agent/outing-domain-example";
import { z } from "zod";

import { authorize } from "./authorize.js";
import { handleCorsPreflight, withCors } from "./cors.js";
import { createGeminiFreeTextResolver } from "./free-text-resolver.js";
import { planGenerator } from "./plan-generator.js";
import { createGeminiPlanImprover } from "./plan-improver.js";
import { replanRuntime } from "./replan-runtime.js";

export { ExecutionSessionAgent };

const DEMO_CONTEXT = {
  actorId: "demo-user",
  roles: ["owner"] as string[],
  claims: {} as Record<string, unknown>,
};

const belongingArraySchema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    chargePercent: z.number().min(0).max(100).optional(),
  }),
);

const taskArraySchema = z.array(
  z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    estimatedDurationSeconds: z.number().positive().optional(),
    notes: z.string().optional(),
  }),
);

const placeLabelSchema = z.string().trim().min(1).max(160);

const worker = createPearWorker({
  authorize,
  planGenerator,
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
    /** Single-field structure — always Gemini (no deterministic free-text). */
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

      const base = {
        domainId,
        freeTextResolver,
        context,
        value: { freeText },
      };

      if (field === "departureAt") {
        return resolveMaybeFreeTextField({
          ...base,
          field,
          parse: (value): string => z.iso.datetime().parse(value),
          hint: "ISO-8601 datetime string",
        });
      }
      if (field === "belongings") {
        return resolveMaybeFreeTextField({
          ...base,
          field,
          parse: (value) => belongingArraySchema.min(1).parse(value),
          hint: "Array of { id, name, chargePercent? }",
        });
      }
      if (field === "tasks") {
        return resolveMaybeFreeTextField({
          ...base,
          field,
          parse: (value) => taskArraySchema.min(1).parse(value),
          hint: "Array of { id, title, estimatedDurationSeconds?, notes? }",
        });
      }
      if (field === "originLabel" || field === "destinationLabel") {
        return resolveMaybeFreeTextField({
          ...base,
          field,
          parse: (value): string => placeLabelSchema.parse(value),
          hint: "Short place label",
        });
      }
      throw new Error(`Unsupported free-text field: ${field}`);
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
