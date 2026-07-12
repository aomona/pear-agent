-- PEAR Execution State (Issue #4). Continuation / plan version history are later issues.

CREATE TABLE execution_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  domain_id TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  goal_id TEXT NOT NULL,
  actor_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE materialized_states (
  session_id TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);

CREATE TABLE runtime_events (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);

CREATE UNIQUE INDEX runtime_events_session_idempotency
  ON runtime_events (session_id, idempotency_key);

CREATE INDEX runtime_events_session_occurred
  ON runtime_events (session_id, occurred_at);

CREATE TABLE raw_inputs (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT,
  byte_size INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);

CREATE INDEX raw_inputs_session ON raw_inputs (session_id);

CREATE TABLE normalized_inputs (
  session_id TEXT PRIMARY KEY NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);
