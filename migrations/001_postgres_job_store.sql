CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  task text NOT NULL,
  status text NOT NULL,
  workspace_path text NOT NULL,
  steps_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  result text,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS job_events (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS job_events_job_id_id_idx ON job_events (job_id, id);
