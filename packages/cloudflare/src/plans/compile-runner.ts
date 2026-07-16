import {
  DEFAULT_CLARIFICATION_TIMEOUT_MS,
  assertPlanMatchesGoal,
  validatePlanGraph,
} from "@pear-agent/core";

import { D1CompileRepository, CompileJobNotFoundError } from "../d1/compile-repository.js";
import type { StoredPlanArtifact } from "../d1/plan-repository.js";
import type { PearRequestContext } from "../context.js";
import type { PearEnv } from "../env.js";
import type { PlanCompileRuntime } from "./host-ports.js";
import { planRepository } from "./routes/shared.js";

export type PlanCompileWorkflowParams = {
  jobId: string;
  planId: string;
  compileInput: unknown;
  clarificationAnswers?: Readonly<Record<string, string>>;
  context: PearRequestContext;
};

export type PlanCompileRunResult = {
  job: import("@pear-agent/core").CompileJob;
  artifact?: StoredPlanArtifact;
  clarification?: import("@pear-agent/core").ClarificationRequest;
};

export async function runPlanCompileJob(input: {
  env: PearEnv;
  params: PlanCompileWorkflowParams;
  runtime: PlanCompileRuntime;
}): Promise<PlanCompileRunResult> {
  const { env, params, runtime } = input;
  const repository = new D1CompileRepository(env.DB);
  const artifact = await planRepository(env).getStored(params.planId);
  if (!artifact) throw new Error(`Plan artifact not found: ${params.planId}`);
  const sources = (await repository.listSources(params.planId)).filter(
    ({ status }) => status === "ready",
  );
  if (sources.length === 0) throw new Error("At least one source is required");
  await repository.transitionJob(params.jobId, ["queued"], {
    phase: "interpret",
    status: "running",
  });
  const abortController = new AbortController();

  try {
    const interpretableSources = await Promise.all(
      sources.map(async (source) => {
        if (!source.rawObjectKey) return { artifact: source };
        const object = await env.RAW_INPUTS.get(source.rawObjectKey);
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
      compileInput: params.compileInput,
      ...(params.clarificationAnswers ? { clarificationAnswers: params.clarificationAnswers } : {}),
      context: params.context,
      signal: abortController.signal,
    });
    await assertActive(repository, params.jobId);

    if (result.kind === "clarification_required") {
      await repository.recordGeneration({
        planArtifactId: params.planId,
        compileJobId: params.jobId,
        generation: result.interpretationGeneration,
      });
      const job = await repository.transitionJob(params.jobId, ["running"], {
        phase: "awaiting_clarification",
        status: "waiting",
        modelCalls: result.interpretationGeneration.attempt,
        totalTokens: result.interpretationGeneration.totalTokens ?? 0,
      });
      const clarification = await repository.createClarification({
        planArtifactId: params.planId,
        compileJobId: params.jobId,
        questions: result.questions,
        expiresAt: new Date(Date.now() + DEFAULT_CLARIFICATION_TIMEOUT_MS),
      });
      return { job, clarification };
    }

    validateGeneratedPlan(
      result.plan,
      artifact,
      sources.map(({ id }) => id),
    );
    await repository.saveInterpretation({
      planArtifactId: params.planId,
      compileJobId: params.jobId,
      normalizedInput: result.normalizedInput,
      assumptions: result.assumptions,
      generation: result.interpretationGeneration,
    });
    await repository.recordGeneration({
      planArtifactId: params.planId,
      compileJobId: params.jobId,
      generation: result.planGeneration,
    });
    await assertActive(repository, params.jobId);
    const totalTokens =
      (result.interpretationGeneration.totalTokens ?? 0) + (result.planGeneration.totalTokens ?? 0);
    const modelCalls = result.interpretationGeneration.attempt + result.planGeneration.attempt;
    const stored = await planRepository(env).saveVersionStored({
      artifactId: params.planId,
      plan: { ...result.plan, version: artifact.version + 1 },
      changeReason: "ai_generation",
      summary: "AI compile draft",
      status: "draft",
      normalizedInput: result.normalizedInput,
      compileCommit: { jobId: params.jobId, modelCalls, totalTokens },
    });
    const job = await repository.getJob(params.jobId);
    if (!job) throw new CompileJobNotFoundError(params.jobId);
    return { job, artifact: stored };
  } catch (error) {
    const current = await repository.getJob(params.jobId);
    if (current?.status === "cancelled") return { job: current };
    if (current && ["queued", "running", "waiting"].includes(current.status)) {
      await repository.updateJob(params.jobId, {
        status: "failed",
        error: error instanceof Error ? error.message.slice(0, 4_000) : "Compile failed",
      });
    }
    throw error;
  }
}

async function assertActive(repository: D1CompileRepository, jobId: string): Promise<void> {
  const current = await repository.getJob(jobId);
  if (!current || current.status !== "running") {
    throw new Error(`Compile job is no longer active (${current?.status ?? "missing"})`);
  }
}

function validateGeneratedPlan(
  plan: import("@pear-agent/core").ExecutionPlan,
  artifact: StoredPlanArtifact,
  sourceIds: readonly string[],
): void {
  const match = assertPlanMatchesGoal(plan, artifact.goal);
  if (!match.ok) throw new Error(`Generated plan goal mismatch: ${match.reason}`);
  const graph = validatePlanGraph(plan.steps);
  if (!graph.valid) throw new Error(`Generated plan graph is invalid: ${graph.reason}`);
  const knownSourceIds = new Set(sourceIds);
  for (const step of plan.steps) {
    if (!step.sourceRefs?.length)
      throw new Error(`Generated step ${step.id} has no source provenance`);
    for (const reference of step.sourceRefs) {
      if (!knownSourceIds.has(reference.sourceId)) {
        throw new Error(
          `Generated step ${step.id} references unknown source ${reference.sourceId}`,
        );
      }
    }
  }
}
