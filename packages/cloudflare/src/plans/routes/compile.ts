import { type SourceKind } from "@pear-agent/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { D1CompileRepository, CompileJobNotFoundError } from "../../d1/compile-repository.js";
import { PlanArtifactNotFoundError } from "../../d1/plan-repository.js";
import type { PearRequestContext } from "../../context.js";
import type { PearEnv } from "../../env.js";
import type { PearApp } from "../../http/app.js";
import { toJsonValue } from "../../serialize.js";
import { assertPlanMutable } from "../assert-plan-mutable.js";
import { runPlanCompileJob, type PlanCompileWorkflowParams } from "../compile-runner.js";
import { artifactJson, planRepository, type PlanRouteContext } from "./shared.js";
import {
  assertSize,
  assertSupportedMediaType,
  fetchPublicSource,
  normalizeMediaType,
  maximumSize,
  readBodyWithLimit,
  sha256,
  validatePublicUrl,
} from "./public-url.js";

const MAX_TEXT_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES_PER_PLAN = 20;
const SOURCE_FETCH_TIMEOUT_MS = 30_000;
const INLINE_COMPILE_TIMEOUT_MS = 30 * 60 * 1_000;

const sourceBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    label: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(MAX_TEXT_SOURCE_BYTES),
    mediaType: z.enum(["text/plain", "text/markdown", "application/json"]).default("text/plain"),
  }),
  z.object({
    kind: z.literal("url"),
    label: z.string().trim().min(1).max(200).optional(),
    url: z.url(),
  }),
]);

const compileBodySchema = z.object({
  compileInput: z.unknown().default({}),
  clarificationAnswers: z.record(z.string(), z.string().trim().min(1).max(10_000)).optional(),
  /** Resume an existing re-queued job (used after clarification answer). */
  resumeJobId: z.string().min(1).optional(),
});

export function registerPlanCompileRoutes(app: PearApp, routes: PlanRouteContext): void {
  app.get("/plans/:planId/sources", async (c) => {
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.source.read", planId }, c.get("pearContext"));
    await requireArtifact(c.env, planId);
    const sources = await new D1CompileRepository(c.env.DB).listSources(planId);
    return c.json({ sources: toJsonValue(sources) });
  });

  app.post("/plans/:planId/sources", async (c) => {
    const planId = c.req.param("planId");
    const context = c.get("pearContext");
    await routes.authorize({ type: "plan.source.create", planId }, context);
    await requireArtifact(c.env, planId);
    const repository = new D1CompileRepository(c.env.DB);
    await assertPlanMutable(c.env.DB, planId, "change sources");
    const existingSources = (await repository.listSources(planId)).filter(
      ({ status }) => status !== "deleted",
    );
    if (existingSources.length >= MAX_SOURCES_PER_PLAN) {
      throw new HTTPException(409, {
        message: `A plan may have at most ${MAX_SOURCES_PER_PLAN} sources`,
      });
    }

    const contentType = c.req.header("content-type") ?? "";
    let kind: SourceKind;
    let label: string;
    let mediaType: string;
    let sourceUrl: string | null = null;
    let bytes: ArrayBuffer;

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new HTTPException(400, { message: 'multipart field "file" is required' });
      }
      kind = "file";
      label = String(form.get("label") || file.name || "Source file").slice(0, 200);
      mediaType = normalizeMediaType(file.type || "application/octet-stream");
      assertSupportedMediaType(mediaType);
      assertSize(file.size, mediaType);
      bytes = await file.arrayBuffer();
    } else {
      const body = sourceBodySchema.parse(await c.req.json());
      kind = body.kind;
      if (body.kind === "text") {
        label = body.label;
        mediaType = body.mediaType;
        bytes = new TextEncoder().encode(body.content).buffer as ArrayBuffer;
        assertSize(bytes.byteLength, mediaType);
      } else {
        const url = validatePublicUrl(body.url);
        const sourceSignal = AbortSignal.any([
          c.req.raw.signal,
          AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
        ]);
        const response = await fetchPublicSource(url, sourceSignal);
        if (!response.ok) {
          throw new HTTPException(400, { message: `Source URL returned HTTP ${response.status}` });
        }
        sourceUrl = url.toString();
        label = body.label ?? url.hostname;
        mediaType = normalizeMediaType(response.headers.get("content-type") ?? "text/html");
        assertSupportedMediaType(mediaType);
        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (declaredLength) assertSize(declaredLength, mediaType);
        bytes = await readBodyWithLimit(response, maximumSize(mediaType), sourceSignal);
      }
    }

    const id = crypto.randomUUID();
    const objectKey = `plan-artifacts/${planId}/sources/${id}`;
    const checksumSha256 = await sha256(bytes);
    // Re-check after potentially slow URL fetch before writing R2.
    await assertPlanMutable(c.env.DB, planId, "change sources");
    await c.env.RAW_INPUTS.put(objectKey, bytes, { httpMetadata: { contentType: mediaType } });
    let source;
    try {
      source = await repository.createSourceIfIdle(
        {
          id,
          planArtifactId: planId,
          kind,
          label,
          mediaType,
          byteSize: bytes.byteLength,
          checksumSha256,
          sourceUrl,
          rawObjectKey: objectKey,
          createdByActorId: context.actorId,
        },
        MAX_SOURCES_PER_PLAN,
      );
    } catch (error) {
      await c.env.RAW_INPUTS.delete(objectKey);
      throw error;
    }
    await planRepository(c.env).updateMeta({ artifactId: planId, status: "draft" });
    return c.json({ source: toJsonValue(source) }, 201);
  });

  app.delete("/plans/:planId/sources/:sourceId", async (c) => {
    const planId = c.req.param("planId");
    const sourceId = c.req.param("sourceId");
    await routes.authorize({ type: "plan.source.delete", planId, sourceId }, c.get("pearContext"));
    await requireArtifact(c.env, planId);
    await assertPlanMutable(c.env.DB, planId, "change sources");
    const repository = new D1CompileRepository(c.env.DB);
    const versions = await planRepository(c.env).getVersionHistory(planId);
    if (
      versions.some(({ plan }) =>
        plan.steps.some((step) => step.sourceRefs?.some((ref) => ref.sourceId === sourceId)),
      )
    ) {
      throw new HTTPException(409, {
        message: "Source is referenced by plan history and cannot be deleted",
      });
    }
    if (await repository.isSourceReferenced(planId, sourceId)) {
      throw new HTTPException(409, {
        message: "Source is referenced by compile history and cannot be deleted",
      });
    }
    const source = (await repository.listSources(planId)).find(({ id }) => id === sourceId);
    if (!source) throw new HTTPException(404, { message: "Plan source not found" });
    const deleting = await repository.markSourceDeletingIfIdle(planId, sourceId);
    if (!deleting) throw new HTTPException(404, { message: "Plan source not found" });
    await Promise.all([
      source.rawObjectKey ? c.env.RAW_INPUTS.delete(source.rawObjectKey) : Promise.resolve(),
      source.extractedObjectKey
        ? c.env.RAW_INPUTS.delete(source.extractedObjectKey)
        : Promise.resolve(),
    ]);
    await repository.finalizeSourceDeleted(planId, sourceId);
    await planRepository(c.env).updateMeta({ artifactId: planId, status: "draft" });
    return c.body(null, 204);
  });

  app.post("/plans/:planId/compile-jobs", async (c) => {
    const planId = c.req.param("planId");
    const context = c.get("pearContext");
    await routes.authorize({ type: "plan.compile.start", planId }, context);
    const body = compileBodySchema.parse(await c.req.json());
    return executeCompileStart({
      env: c.env,
      routes,
      planId,
      body,
      context,
      requestSignal: c.req.raw.signal,
    });
  });

  app.get("/plans/:planId/compile-jobs/:jobId", async (c) => {
    const planId = c.req.param("planId");
    const jobId = c.req.param("jobId");
    await routes.authorize({ type: "plan.compile.read", planId, jobId }, c.get("pearContext"));
    const repository = new D1CompileRepository(c.env.DB);
    await repository.expireClarifications(planId);
    const job = await repository.getJob(jobId);
    if (!job || job.planArtifactId !== planId) throw new CompileJobNotFoundError(jobId);
    return c.json({ job: toJsonValue(job) });
  });

  app.post("/plans/:planId/compile-jobs/:jobId/cancel", async (c) => {
    const planId = c.req.param("planId");
    const jobId = c.req.param("jobId");
    await routes.authorize({ type: "plan.compile.cancel", planId, jobId }, c.get("pearContext"));
    const repository = new D1CompileRepository(c.env.DB);
    const job = await repository.getJob(jobId);
    if (!job || job.planArtifactId !== planId) throw new CompileJobNotFoundError(jobId);
    if (!["queued", "running", "waiting"].includes(job.status)) {
      throw new HTTPException(409, { message: `Cannot cancel a ${job.status} compile job` });
    }
    const cancelled = await repository.transitionJob(jobId, ["queued", "running", "waiting"], {
      status: "cancelled",
    });
    if (job.workflowInstanceId && c.env.PLAN_COMPILE_WORKFLOW) {
      await c.env.PLAN_COMPILE_WORKFLOW.get(job.workflowInstanceId)
        .then((instance) => instance.terminate())
        .catch(() => undefined);
    }
    return c.json({ job: toJsonValue(cancelled) });
  });

  app.post("/plans/:planId/compile-jobs/:jobId/retry", async (c) => {
    const planId = c.req.param("planId");
    const jobId = c.req.param("jobId");
    await routes.authorize({ type: "plan.compile.retry", planId, jobId }, c.get("pearContext"));
    const repository = new D1CompileRepository(c.env.DB);
    const job = await repository.getJob(jobId);
    if (!job || job.planArtifactId !== planId) throw new CompileJobNotFoundError(jobId);
    if (!["failed", "cancelled", "expired"].includes(job.status)) {
      throw new HTTPException(409, { message: `Cannot retry a ${job.status} compile job` });
    }
    const body = compileBodySchema.parse(await c.req.json());
    return executeCompileStart({
      env: c.env,
      routes,
      planId,
      body,
      context: c.get("pearContext"),
      requestSignal: c.req.raw.signal,
    });
  });

  app.post("/plans/:planId/clarifications/:clarificationId/answer", async (c) => {
    const planId = c.req.param("planId");
    const clarificationId = c.req.param("clarificationId");
    const context = c.get("pearContext");
    await routes.authorize({ type: "plan.clarification.answer", planId, clarificationId }, context);
    const body = z
      .object({
        answers: z.record(z.string(), z.string().trim().min(1).max(10_000)),
        compileInput: z.unknown().optional(),
        /** When true (default), resume the re-queued compile job in the same request. */
        resumeCompile: z.boolean().default(true),
      })
      .parse(await c.req.json());
    const repository = new D1CompileRepository(c.env.DB);
    const clarification = await repository.answerClarification(
      planId,
      clarificationId,
      body.answers,
    );
    if (!body.resumeCompile) {
      return c.json({ clarification: toJsonValue(clarification) });
    }
    // Single product path: answer + resume same job (no cancel + second POST).
    return executeCompileStart({
      env: c.env,
      routes,
      planId,
      body: {
        compileInput: body.compileInput ?? {},
        clarificationAnswers: body.answers,
        resumeJobId: clarification.compileJobId,
      },
      context,
      requestSignal: c.req.raw.signal,
    });
  });

  app.get("/plans/:planId/inspector", async (c) => {
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.compile.read", planId }, c.get("pearContext"));
    await requireArtifact(c.env, planId);
    const inspector = await new D1CompileRepository(c.env.DB).inspect(planId);
    return c.json({ inspector: toJsonValue(inspector) });
  });
}

async function executeCompileStart(input: {
  env: PearEnv;
  routes: PlanRouteContext;
  planId: string;
  body: z.infer<typeof compileBodySchema>;
  context: PearRequestContext;
  requestSignal: AbortSignal;
}): Promise<Response> {
  await requireArtifact(input.env, input.planId);
  const runtime = input.routes.ports.compile.resolve(input.env);
  if (!runtime) {
    throw new HTTPException(503, { message: "Plan compile runtime is not configured" });
  }
  const repository = new D1CompileRepository(input.env.DB);
  let job;
  if (input.body.resumeJobId) {
    const existing = await repository.getJob(input.body.resumeJobId);
    if (!existing || existing.planArtifactId !== input.planId) {
      throw new CompileJobNotFoundError(input.body.resumeJobId);
    }
    if (existing.status !== "queued" && existing.status !== "running") {
      throw new HTTPException(409, {
        message: `Cannot resume a ${existing.status} compile job`,
      });
    }
    job = existing;
  } else {
    job = await repository.createJob(input.planId);
  }
  const sources = (await repository.listSources(input.planId)).filter(
    ({ status }) => status === "ready",
  );
  if (sources.length === 0) {
    await repository.updateJob(job.id, {
      status: "failed",
      error: "At least one source is required",
    });
    throw new HTTPException(400, { message: "At least one source is required" });
  }
  const params: PlanCompileWorkflowParams = {
    jobId: job.id,
    planId: input.planId,
    compileInput: input.body.compileInput,
    ...(input.body.clarificationAnswers
      ? { clarificationAnswers: input.body.clarificationAnswers }
      : {}),
    context: input.context,
  };
  if (input.env.PLAN_COMPILE_WORKFLOW) {
    try {
      const instance = await input.env.PLAN_COMPILE_WORKFLOW.create({ id: job.id, params });
      const queued = await repository.updateJob(job.id, { workflowInstanceId: instance.id });
      return Response.json({ job: toJsonValue(queued) }, { status: 202 });
    } catch (error) {
      await repository.updateJob(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message.slice(0, 4_000) : "Workflow dispatch failed",
      });
      throw new HTTPException(502, { message: "Failed to dispatch plan compile Workflow" });
    }
  }
  try {
    const result = await runPlanCompileJob({
      env: input.env,
      params,
      runtime,
      signal: AbortSignal.any([
        input.requestSignal,
        AbortSignal.timeout(INLINE_COMPILE_TIMEOUT_MS),
      ]),
    });
    if (result.artifact) {
      return Response.json(
        { job: toJsonValue(result.job), ...artifactJson(result.artifact) },
        { status: 201 },
      );
    }
    if (result.clarification) {
      return Response.json(
        { job: toJsonValue(result.job), clarification: toJsonValue(result.clarification) },
        { status: 202 },
      );
    }
    return Response.json({ job: toJsonValue(result.job) }, { status: 409 });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (
      error instanceof Error &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
    ) {
      const status = (error as { status: number }).status;
      if (status === 400 || status === 404 || status === 409) {
        throw new HTTPException(status, { message: error.message });
      }
    }
    throw new HTTPException(502, { message: "Plan compilation failed" });
  }
}

async function requireArtifact(env: { DB: D1Database }, planId: string) {
  const artifact = await planRepository(env).getStored(planId);
  if (!artifact) throw new PlanArtifactNotFoundError(planId);
  return artifact;
}
