CREATE TABLE growth_v2.staff_users (
  staff_user_id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role varchar(20) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CONSTRAINT staff_users_email_normalized CHECK (email = lower(btrim(email))),
  CONSTRAINT staff_users_role_allowed CHECK (role IN ('admin', 'viewer'))
);

CREATE TABLE growth_v2.staff_sessions (
  staff_session_id uuid PRIMARY KEY,
  staff_user_id uuid NOT NULL REFERENCES growth_v2.staff_users(staff_user_id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_sessions_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT staff_sessions_seen_order CHECK (last_seen_at >= created_at)
);

CREATE INDEX staff_sessions_user_active_idx
  ON growth_v2.staff_sessions (staff_user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX sessions_reporting_idx
  ON growth_v2.sessions (started_at DESC, session_id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX sessions_reporting_qa_idx
  ON growth_v2.sessions (is_qa, started_at DESC, session_id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX leads_reporting_idx
  ON growth_v2.leads (created_at DESC, lead_id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX events_reporting_session_idx
  ON growth_v2.events (session_id, event_name, occurred_at DESC);

