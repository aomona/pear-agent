-- Partial replanning and Plan Version history (Issue #8).

ALTER TABLE execution_sessions
  ADD COLUMN domain_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE normalized_inputs
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE plan_versions (
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  patch_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id),
  UNIQUE (session_id, version)
);

CREATE INDEX plan_versions_session_status ON plan_versions (session_id, status);
CREATE UNIQUE INDEX plan_versions_one_active
  ON plan_versions (session_id) WHERE status = 'active';

CREATE TABLE plan_patches (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  base_plan_version INTEGER NOT NULL,
  cause_key TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  validation_domain_version INTEGER NOT NULL,
  normalized_input_revision INTEGER,
  target_plan_version INTEGER,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  candidate_world_state_json TEXT NOT NULL,
  failure_reason TEXT,
  active_step_ids_json TEXT NOT NULL,
  transition_token TEXT,
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);

CREATE INDEX plan_patches_session_created ON plan_patches (session_id, created_at);
CREATE UNIQUE INDEX plan_patches_session_attempt
  ON plan_patches (session_id, attempt_key);
CREATE UNIQUE INDEX plan_patches_session_successful_cause
  ON plan_patches (session_id, cause_key)
  WHERE status IN ('suggested', 'pending_confirmation', 'applied');

INSERT INTO plan_versions
  (session_id, version, plan_json, patch_id, status, created_at)
SELECT
  es.id,
  es.plan_version,
  json_extract(ms.state_json, '$.plan'),
  NULL,
  'active',
  es.updated_at
FROM execution_sessions es
JOIN materialized_states ms ON ms.session_id = es.id;
