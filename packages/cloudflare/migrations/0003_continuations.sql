-- Continuation Runtime (Issue #7).

CREATE TABLE execution_continuations (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  wake_condition_json TEXT NOT NULL,
  suspended_reason TEXT NOT NULL,
  resume_directive TEXT NOT NULL,
  checkpoint_plan_version_id TEXT NOT NULL,
  checkpoint_last_event_id TEXT,
  checkpoint_snapshot_json TEXT NOT NULL,
  provider_resume_handle TEXT,
  scheduler_id TEXT,
  resuming_actor_id TEXT,
  resume_attempt_id TEXT,
  resume_claimed_at TEXT,
  transition_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);

CREATE INDEX execution_continuations_session_status
  ON execution_continuations (session_id, status);
