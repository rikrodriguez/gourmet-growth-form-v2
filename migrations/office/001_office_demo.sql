-- Synthetic development state only. The existing pure domain remains the source
-- of approval, revision and idempotency rules; one locked aggregate commits them
-- together with jobs/history. No production database or outbound queue is used.
CREATE SCHEMA IF NOT EXISTS office_demo;

CREATE TABLE IF NOT EXISTS office_demo.migrations (
  name text PRIMARY KEY,
  sha256 char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS office_demo.states (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,95}$'),
  payload jsonb NOT NULL CHECK (
    payload->>'version' = '1' AND
    payload->>'mode' = 'simulation' AND
    payload->'office'->>'syntheticOnly' = 'true'
  ),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS office_demo.command_events (
  state_id text NOT NULL REFERENCES office_demo.states(id),
  command_key text NOT NULL,
  digest char(64) NOT NULL,
  case_id text NOT NULL CHECK (case_id IN ('demo-aurora', 'demo-cedar', 'demo-harbor')),
  function_id text NOT NULL CHECK (function_id IN ('sales', 'proposals', 'coordination', 'logistics', 'suppliers', 'finance', 'quality', 'marketing', 'talent')),
  action text NOT NULL CHECK (action IN ('draft', 'chat', 'approve', 'reject', 'cancel', 'revise')),
  actor_id text NOT NULL CHECK (actor_id = 'OFFICE_DEMO_OPERATOR'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (state_id, command_key)
);
