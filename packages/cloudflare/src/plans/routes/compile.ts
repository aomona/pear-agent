import {
  DEFAULT_CLARIFICATION_TIMEOUT_MS,
  assertPlanMatchesGoal,
  validatePlanGraph,
  type SourceKind,
} from "@pear-agent/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { D1CompileRepository, CompileJobNotFoundError } from "../../d1/compile-repository.js";
import { PlanArtifactNotFoundError } from "../../d1/plan-repository.js";
import type { PearApp } from "../../http/app.js";
import { toJsonValue } from "../../serialize.js";
import { artifactJson, planRepository, type PlanRouteContext } from "./shared.js";

const MAX_TEXT_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_SOURCES_PER_PLAN = 20;
const SUPPORTED_FILE_TYPES = new Set([
  "application/json",
  "application/pdf",
  "text/html",
  "text/markdown",
  "text/plain",
]);

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
    if (await repository.getActiveJob(planId)) {
      throw new HTTPException(409, { message: "Sources cannot change during an active compile" });
    }
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
      } else {
        const url = validatePublicUrl(body.url);
        const response = await fetchPublicSource(url);
        if (!response.ok) {
          throw new HTTPException(400, { message: `Source URL returned HTTP ${response.status}` });
        }
        sourceUrl = url.toString();
        label = body.label ?? url.hostname;
        mediaType = normalizeMediaType(response.headers.get("content-type") ?? "text/html");
        assertSupportedMediaType(mediaType);
        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (declaredLength) assertSize(declaredLength, mediaType);
        bytes = await response.arrayBuffer();
        assertSize(bytes.byteLength, mediaType);
      }
    }

    const id = crypto.randomUUID();
    const objectKey = `plan-artifacts/${planId}/sources/${id}`;
    const checksumSha256 = await sha256(bytes);
    if (await repository.getActiveJob(planId)) {
      throw new HTTPException(409, { message: "Sources cannot change during an active compile" });
    }
    await c.env.RAW_INPUTS.put(objectKey, bytes, { httpMetadata: { contentType: mediaType } });
    let source;
    try {
      source = await repository.createSource({
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
      });
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
    const repository = new D1CompileRepository(c.env.DB);
    if (await repository.getActiveJob(planId)) {
      throw new HTTPException(409, { message: "Sources cannot change during an active compile" });
    }
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
    if (await repository.getActiveJob(planId)) {
      throw new HTTPException(409, { message: "Sources cannot change during an active compile" });
    }
    await repository.markSourceDeleted(planId, sourceId);
    await Promise.all([
      source.rawObjectKey ? c.env.RAW_INPUTS.delete(source.rawObjectKey) : Promise.resolve(),
      source.extractedObjectKey
        ? c.env.RAW_INPUTS.delete(source.extractedObjectKey)
        : Promise.resolve(),
    ]);
    await planRepository(c.env).updateMeta({ artifactId: planId, status: "draft" });
    return c.body(null, 204);
  });

  app.post("/plans/:planId/compile-jobs", async (c) => {
    const planId = c.req.param("planId");
    const context = c.get("pearContext");
    await routes.authorize({ type: "plan.compile.start", planId }, context);
    const artifact = await requireArtifact(c.env, planId);
    const runtime = routes.ports.compile.resolve(c.env);
    if (!runtime) {
      throw new HTTPException(503, { message: "Plan compile runtime is not configured" });
    }
    const body = compileBodySchema.parse(await c.req.json());
    const repository = new D1CompileRepository(c.env.DB);
    const job = await repository.createJob(planId);
    const sources = (await repository.listSources(planId)).filter(
      ({ status }) => status === "ready",
    );
    if (sources.length === 0) {
      await repository.updateJob(job.id, {
        status: "failed",
        error: "At least one source is required",
      });
      throw new HTTPException(400, { message: "At least one source is required" });
    }
    await repository.updateJob(job.id, { phase: "interpret", status: "running" });

    try {
      const interpretableSources = await Promise.all(
        sources.map(async (source) => {
          if (!source.rawObjectKey) return { artifact: source };
          const object = await c.env.RAW_INPUTS.get(source.rawObjectKey);
          if (!object) throw new Error(`Source object missing: ${source.id}`);
          const data = new Uint8Array(await object.arrayBuffer());
          return source.mediaType === "application/pdf"
            ? { artifact: source, data }
            : { artifact: source, data, extractedText: new TextDecoder().decode(data) };
        }),
      );
      const result = await runtime.compile({
        artifact,
        sources: interpretableSources,
        compileInput: body.compileInput,
        ...(body.clarificationAnswers ? { clarificationAnswers: body.clarificationAnswers } : {}),
        context,
      });
      await assertCompileJobActive(repository, job.id);
      if (result.kind === "clarification_required") {
        await repository.recordGeneration({
          planArtifactId: planId,
          compileJobId: job.id,
          generation: result.interpretationGeneration,
        });
        const updatedJob = await repository.transitionJob(job.id, ["running"], {
          phase: "awaiting_clarification",
          status: "waiting",
          modelCalls: result.interpretationGeneration.attempt,
          totalTokens: result.interpretationGeneration.totalTokens ?? 0,
        });
        const clarification = await repository.createClarification({
          planArtifactId: planId,
          compileJobId: job.id,
          questions: result.questions,
          expiresAt: new Date(Date.now() + DEFAULT_CLARIFICATION_TIMEOUT_MS),
        });
        return c.json(
          { job: toJsonValue(updatedJob), clarification: toJsonValue(clarification) },
          202,
        );
      }

      const match = assertPlanMatchesGoal(result.plan, artifact.goal);
      if (!match.ok) throw new Error(`Generated plan goal mismatch: ${match.reason}`);
      const graph = validatePlanGraph(result.plan.steps);
      if (!graph.valid) throw new Error(`Generated plan graph is invalid: ${graph.reason}`);
      const sourceIds = new Set(sources.map(({ id }) => id));
      for (const step of result.plan.steps) {
        if (!step.sourceRefs?.length) {
          throw new Error(`Generated step ${step.id} has no source provenance`);
        }
        for (const reference of step.sourceRefs) {
          if (!sourceIds.has(reference.sourceId)) {
            throw new Error(
              `Generated step ${step.id} references unknown source ${reference.sourceId}`,
            );
          }
        }
      }
      await repository.saveInterpretation({
        planArtifactId: planId,
        compileJobId: job.id,
        normalizedInput: result.normalizedInput,
        assumptions: result.assumptions,
        generation: result.interpretationGeneration,
      });
      await repository.recordGeneration({
        planArtifactId: planId,
        compileJobId: job.id,
        generation: result.planGeneration,
      });
      await assertCompileJobActive(repository, job.id);
      const stored = await planRepository(c.env).saveVersionStored({
        artifactId: planId,
        plan: { ...result.plan, version: artifact.version + 1 },
        changeReason: "ai_generation",
        summary: "AI compile draft",
        status: "draft",
        normalizedInput: result.normalizedInput,
      });
      const totalTokens =
        (result.interpretationGeneration.totalTokens ?? 0) +
        (result.planGeneration.totalTokens ?? 0);
      const updatedJob = await repository.transitionJob(job.id, ["running"], {
        phase: "review",
        status: "completed",
        modelCalls: result.interpretationGeneration.attempt + result.planGeneration.attempt,
        totalTokens,
      });
      return c.json({ job: toJsonValue(updatedJob), ...artifactJson(stored) }, 201);
    } catch (error) {
      const currentJob = await repository.getJob(job.id);
      if (currentJob?.status === "cancelled") {
        return c.json({ job: toJsonValue(currentJob) }, 409);
      }
      await repository.updateJob(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message.slice(0, 4_000) : "Compile failed",
      });
      throw new HTTPException(502, {
        message: error instanceof Error ? error.message : "Plan compile failed",
      });
    }
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
    return c.json({
      job: toJsonValue(
        await repository.transitionJob(jobId, ["queued", "running", "waiting"], {
          status: "cancelled",
        }),
      ),
    });
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
    const retryRequest = new Request(new URL(`/plans/${planId}/compile-jobs`, c.req.url), {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    });
    return app.fetch(retryRequest, c.env);
  });

  app.post("/plans/:planId/clarifications/:clarificationId/answer", async (c) => {
    const planId = c.req.param("planId");
    const clarificationId = c.req.param("clarificationId");
    await routes.authorize(
      { type: "plan.clarification.answer", planId, clarificationId },
      c.get("pearContext"),
    );
    const answers = z
      .object({ answers: z.record(z.string(), z.string().trim().min(1).max(10_000)) })
      .parse(await c.req.json()).answers;
    const repository = new D1CompileRepository(c.env.DB);
    const clarification = await repository.answerClarification(planId, clarificationId, answers);
    await repository.updateJob(clarification.compileJobId, {
      status: "cancelled",
      error: "Superseded by a resumed compile with clarification answers",
    });
    return c.json({ clarification: toJsonValue(clarification) });
  });

  app.get("/plans/:planId/inspector", async (c) => {
    const planId = c.req.param("planId");
    await routes.authorize({ type: "plan.compile.read", planId }, c.get("pearContext"));
    await requireArtifact(c.env, planId);
    const inspector = await new D1CompileRepository(c.env.DB).inspect(planId);
    return c.json({ inspector: toJsonValue(inspector) });
  });
}

async function requireArtifact(env: { DB: D1Database }, planId: string) {
  const artifact = await planRepository(env).getStored(planId);
  if (!artifact) throw new PlanArtifactNotFoundError(planId);
  return artifact;
}

async function assertCompileJobActive(
  repository: D1CompileRepository,
  jobId: string,
): Promise<void> {
  const current = await repository.getJob(jobId);
  if (!current || current.status !== "running") {
    throw new Error(`Compile job is no longer active (${current?.status ?? "missing"})`);
  }
}

function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function assertSupportedMediaType(mediaType: string): void {
  if (!SUPPORTED_FILE_TYPES.has(mediaType)) {
    throw new HTTPException(415, { message: `Unsupported source media type: ${mediaType}` });
  }
}

function assertSize(size: number, mediaType: string): void {
  const maximum =
    mediaType === "application/pdf"
      ? MAX_PDF_BYTES
      : mediaType === "text/html"
        ? MAX_TEXT_SOURCE_BYTES
        : MAX_TEXT_FILE_BYTES;
  if (size > maximum) {
    throw new HTTPException(413, { message: `Source exceeds ${maximum} bytes` });
  }
}

export function validatePublicUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HTTPException(400, { message: "Source URL must use http or https" });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    isBlockedIpv4(host) ||
    isBlockedIpv6(host)
  ) {
    throw new HTTPException(400, { message: "Private network source URLs are not allowed" });
  }
  return url;
}

function isBlockedIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const normalized = host.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  const firstGroup = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (
    (firstGroup & 0xfe00) === 0xfc00 ||
    (firstGroup & 0xffc0) === 0xfe80 ||
    (firstGroup & 0xff00) === 0xff00
  )
    return true;
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  const mappedHex = normalized.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mappedHex) return false;
  const high = Number.parseInt(mappedHex[1]!, 16);
  const low = Number.parseInt(mappedHex[2]!, 16);
  return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
}

async function fetchPublicSource(initial: URL): Promise<Response> {
  let url = initial;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new HTTPException(400, { message: "Source redirect has no location" });
    url = validatePublicUrl(new URL(location, url).toString());
  }
  throw new HTTPException(400, { message: "Source URL redirected too many times" });
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
