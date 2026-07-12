-- Session-independent plan library (CE-11 PlanArtifact).
-- Distinct from session-scoped plan_versions (runtime replan history).

CREATE TABLE plan_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  domain_id TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  goal_json TEXT NOT NULL,
  current_plan_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  normalized_input_json TEXT,
  owner_actor_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX plan_artifacts_domain_status ON plan_artifacts (domain_id, status);
CREATE INDEX plan_artifacts_updated ON plan_artifacts (updated_at);

CREATE TABLE plan_artifact_versions (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  parent_version INTEGER,
  change_reason TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES plan_artifacts (id),
  UNIQUE (artifact_id, version)
);

CREATE INDEX plan_artifact_versions_artifact ON plan_artifact_versions (artifact_id, version);
