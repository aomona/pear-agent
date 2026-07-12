import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

/**
 * D1 schema for PEAR Execution State (Issue #4).
 * Extended below by Voice Lease, Continuation, and Plan Version history tables.
 */
export const executionSessions = sqliteTable("execution_sessions", {
  id: text("id").primaryKey(),
  domainId: text("domain_id").notNull(),
  domainVersion: integer("domain_version").notNull(),
  status: text("status").notNull(),
  planId: text("plan_id").notNull(),
  planVersion: integer("plan_version").notNull(),
  goalId: text("goal_id").notNull(),
  actorIdsJson: text("actor_ids_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const materializedStates = sqliteTable("materialized_states", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => executionSessions.id),
  stateJson: text("state_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const runtimeEvents = sqliteTable(
  "runtime_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => executionSessions.id),
    idempotencyKey: text("idempotency_key").notNull(),
    eventJson: text("event_json").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    uniqueIndex("runtime_events_session_idempotency").on(table.sessionId, table.idempotencyKey),
    index("runtime_events_session_occurred").on(table.sessionId, table.occurredAt),
  ],
);

export const rawInputs = sqliteTable(
  "raw_inputs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => executionSessions.id),
    objectKey: text("object_key").notNull().unique(),
    contentType: text("content_type"),
    byteSize: integer("byte_size").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    createdAt: text("created_at").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
  },
  (table) => [index("raw_inputs_session").on(table.sessionId)],
);

export const normalizedInputs = sqliteTable("normalized_inputs", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => executionSessions.id),
  payloadJson: text("payload_json").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One row per session (PK = session_id). Exclusive Voice Lease (Issue #6).
 * Re-acquire overwrites the row; status tracks active / released / expired.
 */
export const voiceLeases = sqliteTable("voice_leases", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => executionSessions.id),
  id: text("id").notNull(),
  actorId: text("actor_id").notNull(),
  status: text("status").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  providerResumeHandle: text("provider_resume_handle"),
  updatedAt: text("updated_at").notNull(),
});

export const executionContinuations = sqliteTable(
  "execution_continuations",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => executionSessions.id),
    status: text("status").notNull(),
    wakeConditionJson: text("wake_condition_json").notNull(),
    suspendedReason: text("suspended_reason").notNull(),
    resumeDirective: text("resume_directive").notNull(),
    checkpointPlanVersionId: text("checkpoint_plan_version_id").notNull(),
    checkpointLastEventId: text("checkpoint_last_event_id"),
    checkpointSnapshotJson: text("checkpoint_snapshot_json").notNull(),
    providerResumeHandle: text("provider_resume_handle"),
    schedulerId: text("scheduler_id"),
    resumingActorId: text("resuming_actor_id"),
    resumeAttemptId: text("resume_attempt_id"),
    resumeClaimedAt: text("resume_claimed_at"),
    transitionToken: text("transition_token"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("execution_continuations_session_status").on(table.sessionId, table.status)],
);

export const planVersions = sqliteTable(
  "plan_versions",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => executionSessions.id),
    version: integer("version").notNull(),
    planJson: text("plan_json").notNull(),
    patchId: text("patch_id"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("plan_versions_session_version").on(table.sessionId, table.version),
    uniqueIndex("plan_versions_one_active")
      .on(table.sessionId)
      .where(sql`${table.status} = 'active'`),
    index("plan_versions_session_status").on(table.sessionId, table.status),
  ],
);

export const planPatches = sqliteTable(
  "plan_patches",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => executionSessions.id),
    basePlanVersion: integer("base_plan_version").notNull(),
    causeKey: text("cause_key").notNull(),
    attemptKey: text("attempt_key").notNull(),
    validationDomainVersion: integer("validation_domain_version").notNull(),
    normalizedInputRevision: integer("normalized_input_revision"),
    targetPlanVersion: integer("target_plan_version"),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    patchJson: text("patch_json").notNull(),
    candidateWorldStateJson: text("candidate_world_state_json").notNull(),
    failureReason: text("failure_reason"),
    activeStepIdsJson: text("active_step_ids_json").notNull(),
    transitionToken: text("transition_token"),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("plan_patches_session_attempt").on(table.sessionId, table.attemptKey),
    uniqueIndex("plan_patches_session_successful_cause")
      .on(table.sessionId, table.causeKey)
      .where(sql`${table.status} IN ('suggested', 'pending_confirmation', 'applied')`),
    index("plan_patches_session_created").on(table.sessionId, table.createdAt),
  ],
);

export const pearSchema = {
  executionSessions,
  materializedStates,
  runtimeEvents,
  rawInputs,
  normalizedInputs,
  voiceLeases,
  executionContinuations,
  planVersions,
  planPatches,
};
