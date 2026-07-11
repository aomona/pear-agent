-- Voice Lease (Issue #6). One row per session enforces exclusive lease ownership.

CREATE TABLE voice_leases (
  session_id TEXT PRIMARY KEY NOT NULL,
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  provider_resume_handle TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);
