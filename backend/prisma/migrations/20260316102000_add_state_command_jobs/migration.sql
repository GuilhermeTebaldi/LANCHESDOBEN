CREATE TABLE state_command_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id varchar(200) NOT NULL,
  command_type varchar(80) NOT NULL,
  payload_json jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(120),
  started_at timestamptz,
  finished_at timestamptz,
  last_error varchar(1200),
  actor_user_id uuid,
  request_id varchar(120),
  result_version varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT state_command_jobs_status_valid CHECK (
    status IN ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETED', 'FAILED')
  ),
  CONSTRAINT state_command_jobs_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT state_command_jobs_max_attempts_positive CHECK (max_attempts > 0)
);

CREATE UNIQUE INDEX state_command_jobs_command_id_key ON state_command_jobs (command_id);
CREATE INDEX state_command_jobs_status_next_attempt_created_idx
  ON state_command_jobs (status, next_attempt_at, created_at);
CREATE INDEX state_command_jobs_locked_at_idx
  ON state_command_jobs (locked_at);
CREATE INDEX state_command_jobs_type_created_idx
  ON state_command_jobs (command_type, created_at);
