import {
  analyzeAffectedSubgraph,
  applyPlanPatch,
  lastOperationalEventId,
  mostRestrictiveReplanMode,
  normalizePlanPatchSteps,
  PlanPatchValidationError,
  planPatchSchema,
  replanAssessmentSchema,
  replanModeSchema,
  resolvePlanPatchMode,
  type ReplanCapabilityPolicy,
} from "@pear-agent/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import {
  agentAppendReplanFailure,
  agentConfirmReplan,
  agentGetLatestPlanChange,
  agentGetNormalizedInputRecord,
  agentGetSnapshot,
  agentProposeReplan,
} from "../agent/client.js";
import { AuthorizationError, type AuthorizeFn } from "../authorize.js";
import type { PearRequestContext } from "../context.js";
import type { PearEnv } from "../env.js";
import { SessionNotFoundError } from "../errors.js";
import { toJsonValue } from "../serialize.js";
import { validateReplanConfiguration, type ReplanRuntime } from "./engine.js";
import { sameIdSet } from "./keys.js";

type ReplanHono = Hono<{
  Bindings: PearEnv;
  Variables: { pearContext: PearRequestContext };
}>;

const requestBodySchema = z.object({ mode: replanModeSchema.optional() });
const confirmBodySchema = z.object({ confirmed: z.literal(true) });

class PublicReplanError extends Error {}

class ReplanGeneratorError extends Error {
  constructor(stage: "assessment" | "patch") {
    super(`Replan ${stage} generation failed`);
  }
}

class ReplanAuthorizationBoundaryError extends Error {
  constructor(readonly authorizationError: unknown) {
    super("Replan authorization failed");
  }
}

class ReplanCommitBoundaryError extends Error {
  constructor(readonly commitError: unknown) {
    super("Replan commit response failed");
  }
}

function publicFailureReason(caught: unknown): string {
  if (caught instanceof ReplanGeneratorError) return caught.message;
  if (caught instanceof z.ZodError) return "Generated replan output failed schema validation";
  if (caught instanceof PublicReplanError || caught instanceof PlanPatchValidationError) {
    return caught.message.slice(0, 2_000);
  }
  return "Replan failed";
}

async function stableAttemptId(input: {
  sessionId: string;
  planVersion: number;
  sessionDomainVersion: number;
  configuredDomainVersion: number;
  normalizedInputRevision: number | null;
  mode: "automatic" | "confirm" | "suggest";
  recentEvents: readonly { id: string; type: string }[];
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      input.sessionId,
      input.planVersion,
      input.sessionDomainVersion,
      input.configuredDomainVersion,
      input.normalizedInputRevision,
      input.mode,
      lastOperationalEventId(input.recentEvents),
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `attempt-${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function sessionDomain(
  d1: D1Database,
  sessionId: string,
): Promise<{ id: string; version: number }> {
  const row = await d1
    .prepare("SELECT domain_id, domain_version FROM execution_sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ domain_id: string; domain_version: number }>();
  if (!row) throw new SessionNotFoundError(sessionId);
  return { id: row.domain_id, version: row.domain_version };
}

export function registerReplanRoutes(
  app: ReplanHono,
  authorize: AuthorizeFn,
  runtime?: ReplanRuntime,
): void {
  app.post("/sessions/:sessionId/replans", async (c) => {
    if (!runtime) throw new HTTPException(501, { message: "Replan runtime is not configured" });
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    const body = requestBodySchema.parse(await c.req.json().catch(() => ({})));
    // Mode-neutral preflight before session/config reads prevents existence and
    // host-config side channels without fabricating a policy-significant mode.
    await authorize({ type: "replan.preflight", sessionId }, context);
    const domain = await sessionDomain(c.env.DB, sessionId);
    const configuration = validateReplanConfiguration(
      await runtime.resolveConfiguration(domain.id),
    );
    const mode = mostRestrictiveReplanMode(configuration.defaultMode, body.mode);
    await authorize({ type: "replan.request", sessionId, mode }, context);

    const snapshot = await agentGetSnapshot(c.env, sessionId);
    if (!snapshot) throw new SessionNotFoundError(sessionId);
    if (snapshot.session.status === "completed" || snapshot.session.status === "cancelled") {
      throw new HTTPException(409, {
        message: `Cannot replan a ${snapshot.session.status} session`,
      });
    }
    const normalizedInputRecord = await agentGetNormalizedInputRecord(c.env, sessionId);
    const attemptId = await stableAttemptId({
      sessionId,
      planVersion: snapshot.plan.version,
      sessionDomainVersion: domain.version,
      configuredDomainVersion: configuration.domainVersion,
      normalizedInputRevision: normalizedInputRecord?.revision ?? null,
      mode,
      recentEvents: snapshot.recentEvents,
    });

    if (configuration.domainVersion !== domain.version) {
      const reason = "Session Domain version is incompatible with the configured Replanner";
      await agentAppendReplanFailure(c.env, sessionId, {
        actorId: context.actorId,
        attemptId,
        reason,
      });
      return c.json({ kind: "failed", attemptId, reason }, 409);
    }

    try {
      const generatorInput = {
        sessionId,
        domainId: domain.id,
        normalizedInput: normalizedInputRecord?.payload ?? null,
        instructions: configuration.instructions,
        context,
        goal: snapshot.plan.goal,
        plan: snapshot.plan,
        worldState: snapshot.worldState,
        recentEvents: snapshot.recentEvents,
      };
      let generatedAssessment: unknown;
      try {
        generatedAssessment = await runtime.generator.assess(generatorInput);
      } catch {
        throw new ReplanGeneratorError("assessment");
      }
      const assessment = replanAssessmentSchema.parse(generatedAssessment);
      const recentEventIds = new Set(snapshot.recentEvents.map(({ id }) => id));
      if (assessment.causeEventIds.some((id) => !recentEventIds.has(id))) {
        throw new PublicReplanError(
          "Assessment references an event outside the recent input window",
        );
      }
      if (!assessment.needsReplan) {
        return c.json({ kind: "not_needed", assessment: toJsonValue(assessment) });
      }
      if (
        assessment.causeEventIds.length === 0 ||
        assessment.directlyAffectedStepIds.length === 0
      ) {
        throw new PublicReplanError(
          "Replan assessment requires cause events and directly affected steps",
        );
      }

      const affected = analyzeAffectedSubgraph(snapshot.plan, assessment.directlyAffectedStepIds);
      let generatedPatch: unknown;
      try {
        generatedPatch = await runtime.generator.generatePatch({
          ...generatorInput,
          assessment,
          affectedStepIds: affected.stepIds,
          mode,
        });
      } catch {
        throw new ReplanGeneratorError("patch");
      }
      const generatedPatchFields =
        typeof generatedPatch === "object" &&
        generatedPatch !== null &&
        !Array.isArray(generatedPatch)
          ? generatedPatch
          : {};
      let patch = planPatchSchema.parse({
        ...generatedPatchFields,
        // Patch identity belongs to the Runtime, not model output. This keeps
        // the global D1 primary key collision-free across sessions.
        id: `patch-${crypto.randomUUID()}`,
      });
      const lastEventId = lastOperationalEventId(snapshot.recentEvents);
      if (
        patch.basePlanId !== snapshot.plan.id ||
        patch.basePlanVersion !== snapshot.plan.version ||
        patch.baseLastEventId !== lastEventId
      ) {
        throw new PublicReplanError("Generated patch base does not match the assessed snapshot");
      }
      if (!sameIdSet(patch.causeEventIds, assessment.causeEventIds)) {
        throw new PublicReplanError("Generated patch cause events differ from the assessment");
      }
      const knownStepIds = new Set(snapshot.plan.steps.map(({ id }) => id));
      const addedStepIds = patch.operations
        .filter((operation) => operation.type === "add_step")
        .map((operation) => operation.step.id);
      const existingAffectedIds = patch.affectedStepIds.filter((id) => knownStepIds.has(id));
      const newAffectedIds = patch.affectedStepIds.filter((id) => !knownStepIds.has(id));
      if (
        !sameIdSet(existingAffectedIds, affected.stepIds) ||
        !sameIdSet(newAffectedIds, addedStepIds)
      ) {
        throw new PublicReplanError(
          "Generated patch expands or omits the Runtime affected subgraph",
        );
      }

      // Domain schema and semantic WorldState validation run before the Agent
      // commit. The Agent revalidates generic invariants and the base cursor.
      const validated = applyPlanPatch({
        plan: snapshot.plan,
        stepStates: snapshot.stepStates,
        worldState: snapshot.worldState,
        appliedEventIds: snapshot.recentEvents.map(({ id }) => id),
        currentLastEventId: lastEventId,
        patch,
        phase: "proposal",
        capabilityIds: configuration.capabilityPolicies.map(({ id }) => id),
        stepDataSchema: configuration.stepDataSchema,
        reconcileWorldState: configuration.reconcileWorldState,
      });
      patch = normalizePlanPatchSteps(patch, validated.plan);
      const resolvedMode = resolvePlanPatchMode({
        defaultMode: mode,
        patch,
        capabilityPolicies: configuration.capabilityPolicies,
      });
      if (resolvedMode !== mode) {
        try {
          await authorize({ type: "replan.request", sessionId, mode: resolvedMode }, context);
        } catch (caught) {
          throw new ReplanAuthorizationBoundaryError(caught);
        }
      }

      let result: Awaited<ReturnType<typeof agentProposeReplan>>;
      try {
        result = await agentProposeReplan(c.env, sessionId, {
          actorId: context.actorId,
          mode: resolvedMode,
          patch,
          candidateWorldState: validated.worldState,
          expectedCauseEventIds: assessment.causeEventIds,
          expectedAffectedStepIds: affected.stepIds,
          domainVersion: configuration.domainVersion,
          normalizedInputRevision: normalizedInputRecord?.revision ?? null,
          capabilityPolicies: [...configuration.capabilityPolicies],
        });
      } catch (caught) {
        throw new ReplanCommitBoundaryError(caught);
      }
      return c.json({
        kind: result.kind,
        assessment: toJsonValue(assessment),
        affectedSubgraph: toJsonValue(affected),
        planChange: toJsonValue(result.change),
        state: toJsonValue(result.state),
      });
    } catch (caught) {
      if (caught instanceof ReplanAuthorizationBoundaryError) {
        throw caught.authorizationError;
      }
      if (caught instanceof ReplanCommitBoundaryError) {
        throw new HTTPException(503, { message: "Replan commit is temporarily unavailable" });
      }
      if (caught instanceof AuthorizationError || caught instanceof HTTPException) throw caught;
      const reason = publicFailureReason(caught);
      await agentAppendReplanFailure(c.env, sessionId, {
        actorId: context.actorId,
        attemptId,
        reason,
      });
      return c.json({ kind: "failed", attemptId, reason }, 422);
    }
  });

  app.post("/sessions/:sessionId/plan-patches/:patchId/confirm", async (c) => {
    if (!runtime) throw new HTTPException(501, { message: "Replan runtime is not configured" });
    const sessionId = c.req.param("sessionId");
    const patchId = c.req.param("patchId");
    const context = c.get("pearContext");
    confirmBodySchema.parse(await c.req.json());
    await authorize({ type: "replan.confirm", sessionId, patchId }, context);
    const patchRow = await c.env.DB.prepare(
      "SELECT status, validation_domain_version FROM plan_patches WHERE session_id = ? AND id = ?",
    )
      .bind(sessionId, patchId)
      .first<{ status: string; validation_domain_version: number }>();
    if (!patchRow) throw new HTTPException(404, { message: `Unknown plan patch: ${patchId}` });
    if (patchRow.status === "suggested") {
      throw new HTTPException(409, { message: "Suggested patches are advisory and cannot apply" });
    }
    let domainVersion = patchRow.validation_domain_version;
    let capabilityPolicies: ReplanCapabilityPolicy[] = [];
    if (patchRow.status === "pending_confirmation") {
      const domain = await sessionDomain(c.env.DB, sessionId);
      const configuration = validateReplanConfiguration(
        await runtime.resolveConfiguration(domain.id),
      );
      const snapshot = await agentGetSnapshot(c.env, sessionId);
      if (!snapshot) throw new SessionNotFoundError(sessionId);
      if (snapshot.session.status === "completed" || snapshot.session.status === "cancelled") {
        throw new HTTPException(409, {
          message: `Cannot confirm a patch for a ${snapshot.session.status} session`,
        });
      }
      domainVersion = configuration.domainVersion;
      capabilityPolicies = [...configuration.capabilityPolicies];
    }
    let result: Awaited<ReturnType<typeof agentConfirmReplan>>;
    try {
      result = await agentConfirmReplan(c.env, sessionId, {
        actorId: context.actorId,
        patchId,
        humanConfirmed: true,
        domainVersion,
        capabilityPolicies,
      });
    } catch {
      throw new HTTPException(503, { message: "Replan commit is temporarily unavailable" });
    }
    return c.json({
      kind: result.kind,
      planChange: toJsonValue(result.change),
      state: toJsonValue(result.state),
    });
  });

  app.get("/sessions/:sessionId/plan-patches/latest", async (c) => {
    const sessionId = c.req.param("sessionId");
    const context = c.get("pearContext");
    await authorize({ type: "replan.read", sessionId }, context);
    await sessionDomain(c.env.DB, sessionId);
    const change = await agentGetLatestPlanChange(c.env, sessionId);
    return c.json({ planChange: change ? toJsonValue(change) : null });
  });
}
